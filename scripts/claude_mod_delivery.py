"""Opt-in canary native transport. Durable ownership is independent of enablement.

No prompt text is persisted. Uncertain claims block further delivery rather than
falling back to terminal injection. Completion requires native and transcript proof.
"""
import copy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import threading
import time
import uuid

IDENTIFIER = re.compile(r'^[A-Za-z0-9:_-]{1,200}$')


class DeliveryBlocked(RuntimeError):
    def __init__(self, message, status=409):
        super().__init__(message)
        self.status = status


class ClaimJournal:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.RLock()
        self.blocked = False
        self.data = {'version': 1, 'claims': {}, 'recoveryUsed': []}
        if self.path.exists():
            try:
                if self.path.stat().st_size > 1048576:
                    raise ValueError()
                data = json.loads(self.path.read_text())
                if data.get('version') != 1 or not isinstance(data.get('claims'), dict) or not isinstance(data.get('recoveryUsed'), list):
                    raise ValueError()
                for key, claim in data['claims'].items():
                    if not IDENTIFIER.fullmatch(key) or not isinstance(claim, dict) or claim.get('state') not in ('claimed', 'ingested', 'completed'):
                        raise ValueError()
                self.data = data
            except (OSError, ValueError, TypeError, AttributeError):
                self.blocked = True

    def update(self, operation):
        with self.lock:
            if self.blocked:
                raise DeliveryBlocked('journal unavailable', 503)
            new = copy.deepcopy(self.data)
            result = operation(new)
            raw = json.dumps(new, separators=(',', ':')).encode()
            if len(raw) > 1048576 or len(new['claims']) > 1024 or len(new['recoveryUsed']) > 1024:
                raise DeliveryBlocked('journal full', 503)
            tmp = None
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                fd, tmp = tempfile.mkstemp(prefix='.native-claim-', dir=self.path.parent)
                with os.fdopen(fd, 'wb') as f:
                    f.write(raw); f.flush(); os.fsync(f.fileno())
                os.replace(tmp, self.path)
                directory = os.open(self.path.parent, os.O_RDONLY | os.O_DIRECTORY)
                try: os.fsync(directory)
                finally: os.close(directory)
                self.data = new
                return result
            except OSError:
                # Even rename/fsync failure may have persisted a claim. Stop all
                # transport until a fresh journal read can reconcile it.
                self.blocked = True
                raise DeliveryBlocked('journal persistence failed', 503) from None
            finally:
                if tmp and os.path.exists(tmp): os.unlink(tmp)

    def unresolved(self):
        return self.blocked or any(c['state'] != 'completed' for c in self.data['claims'].values())


def records(path, root, baseline=0):
    """Only complete JSONL records from the pinned root, never sidechain records."""
    try:
        with open(path, 'rb') as f:
            if os.fstat(f.fileno()).st_size < baseline:
                return []  # Truncation is uncertainty, not permission to replay.
            f.seek(baseline)
            out = []
            for line in f:
                if not line.endswith(b'\n'): break
                try: record = json.loads(line)
                except ValueError: continue
                if record.get('sessionId') == root and not record.get('isSidechain'):
                    out.append(record)
            return out
    except OSError:
        return []


def prompt_text(record):
    content = record.get('message', {}).get('content', '')
    if isinstance(content, str): return content
    if isinstance(content, list):
        return '\n'.join(x.get('text', '') for x in content if isinstance(x, dict) and x.get('type') == 'text')
    return ''


def ingestion_and_completion(claim, delivery_id):
    marker = '[[devflow-mod-delivery:' + delivery_id + ']]'
    # Claude 2.1.294 attributes native plugin prompts before their exact marker.
    # Accept only this anchored engine envelope, never quoted/embedded markers.
    starts = (marker + '\n', 'The devflow-bridge plugin sent a message:\n' + marker + '\n')
    ingested = False
    ancestors = set()
    for r in records(claim['transcript'], claim['root'], claim['baseline']):
        if r.get('type') == 'user' and prompt_text(r).startswith(starts):
            ingested = True
            ancestors = {r.get('uuid')}
            continue
        if not ingested: continue
        # A later external prompt breaks causality; tool results do not.
        if r.get('type') == 'user' and prompt_text(r):
            break
        if r.get('parentUuid') in ancestors:
            ancestors.add(r.get('uuid'))
            if r.get('type') == 'assistant' and r.get('message', {}).get('stop_reason') == 'end_turn':
                return True, True
    return ingested, False


class NativeTransport:
    def __init__(self, journal, enabled=False, recovery=False):
        self.journal = journal
        self.enabled = enabled
        self.recovery = recovery
        self.lock = threading.RLock()
        self.offer = None
        self.bridge = None
        self.transcript = None
        self.resume = False
        self.boundary_baseline = set()
        self.boundaries = {}
        self.activity = 'idle'

    def attach(self, bridge, transcript, resume=False):
        with self.lock:
            self.bridge, self.transcript, self.resume = bridge, str(transcript), resume
            self.offer = None
            self.boundaries = {}
            self.boundary_baseline = {r.get('uuid') for r in records(self.transcript, bridge.root) if r.get('subtype') == 'compact_boundary'}

    def next(self):
        with self.lock:
            if not self.enabled: return {'mode': 'observe'}
            if self.journal.blocked or self.journal.unresolved() or not self.offer:
                return {'mode': 'delivery', 'delivery': None}
            return {'mode': 'delivery', 'delivery': {k: self.offer[k] for k in ('id', 'text')}}

    def enqueue(self, delivery_id, text, timestamp=None, reply_channel=None, participant_id=None):
        with self.lock:
            if not self.enabled or not self.bridge or self.journal.blocked:
                return False
            if not isinstance(delivery_id, str) or not IDENTIFIER.fullmatch(delivery_id):
                raise DeliveryBlocked('invalid delivery id')
            if len(text) > 65536 or len(text.encode()) > 262144:
                raise DeliveryBlocked('delivery too large')
            if delivery_id in self.journal.data['claims']:
                return True  # Durable ownership, including completed tombstones.
            if self.offer:
                return self.offer['id'] == delivery_id
            if self.journal.unresolved(): return False
            self.offer = {'id': delivery_id, 'text': text, 'timestamp': timestamp,
                          'replyChannel': reply_channel, 'participantId': participant_id}
            return True

    def event(self, body):
        with self.lock:
            event, delivery_id = body['event'], body.get('deliveryId')
            if event == 'turn.start': self.activity = 'working'
            elif event in ('turn.complete', 'session.end'): self.activity = 'idle'
            if event == 'delivery.submitting':
                if not self.enabled: raise DeliveryBlocked('native delivery disabled')
                if delivery_id in self.journal.data['claims']:
                    return {'accepted': True, 'submit': False}
                if not self.offer or self.offer['id'] != delivery_id or self.journal.unresolved():
                    raise DeliveryBlocked('delivery not offered')
                try: baseline = os.path.getsize(self.transcript)
                except FileNotFoundError: baseline = 0
                claim = {'state': 'claimed', 'generation': self.bridge.generation,
                         'root': self.bridge.root, 'transcript': self.transcript, 'baseline': baseline,
                         'timestamp': self.offer['timestamp'], 'turnId': None, 'completion': None,
                         'replyChannel': self.offer['replyChannel'], 'participantId': self.offer['participantId']}
                self.journal.update(lambda d: d['claims'].__setitem__(delivery_id, claim))
                self.offer = None
                return {'accepted': True, 'submit': True}
            if event.startswith('delivery.'):
                claim = self.journal.data['claims'].get(delivery_id)
                if not claim or claim['generation'] != self.bridge.generation:
                    raise DeliveryBlocked('unclaimed delivery')
                # Drop/error/resolution never relinquishes ownership or acknowledges handling.
                self.journal.update(lambda d: d['claims'][delivery_id].update(submission=event))
            elif event in ('turn.start', 'turn.complete'):
                for delivery_id in body.get('deliveryIds', []):
                    claim = self.journal.data['claims'].get(delivery_id)
                    if not claim or claim['generation'] != self.bridge.generation: continue
                    if event == 'turn.start' and not claim['turnId']:
                        self.journal.update(lambda d: d['claims'][delivery_id].update(turnId=body['turnId'], startedAt=datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')))
                    elif event == 'turn.complete' and claim['turnId'] == body['turnId']:
                        self.journal.update(lambda d: d['claims'][delivery_id].update(completion={
                            'aborted': body.get('isAborted', False), 'disposition': body.get('disposition', 'unknown'),
                            'reason': body.get('reason'), 'completedAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')}))
            return {'accepted': True}

    def reconcile(self):
        """Return proven completed IDs for wrapper/server acknowledgement; no replay."""
        with self.lock:
            if self.journal.blocked: return []
            ready = []
            for delivery_id, claim in list(self.journal.data['claims'].items()):
                if claim['state'] == 'completed': continue
                ingested, ended = ingestion_and_completion(claim, delivery_id)
                if not ingested or not claim['turnId']: continue
                if claim['state'] != 'ingested':
                    self.journal.update(lambda d: d['claims'][delivery_id].update(state='ingested'))
                completion = claim.get('completion')
                if (ended and completion and completion.get('reason') == 'answer'
                        and completion.get('aborted') is False
                        and completion.get('disposition') in ('no_reply', 'empty', 'text')):
                    ready.append((delivery_id, claim))
            return ready

    def complete(self, delivery_id):
        self.journal.update(lambda d: d['claims'][delivery_id].update(state='completed'))

    def boundary(self, source):
        with self.lock:
            if not self.recovery or not self.bridge: return {'accepted': True}
            if source == 'resume':
                if not self.resume or not records(self.transcript, self.bridge.root): return {'accepted': True}
                key = 'resume:' + self.bridge.generation
            else:
                # SessionStart can precede the engine's transcript flush. Leave
                # headroom within the plugin's 750 ms HTTP request deadline.
                deadline = time.monotonic() + 0.5
                while True:
                    found = [r.get('uuid') for r in records(self.transcript, self.bridge.root)
                             if r.get('type') == 'system' and r.get('subtype') == 'compact_boundary'
                             and isinstance(r.get('uuid'), str) and r['uuid']
                             and r['uuid'] not in self.boundary_baseline
                             and ('compact:' + self.bridge.root + ':' + r['uuid']) not in self.journal.data['recoveryUsed']]
                    if found: break
                    remaining = deadline - time.monotonic()
                    if remaining <= 0: return {'accepted': True}
                    time.sleep(min(0.02, remaining))
                key = 'compact:' + self.bridge.root + ':' + found[-1]
            boundary_id = hashlib.sha256(key.encode()).hexdigest()
            self.boundaries[boundary_id] = key
            return {'accepted': True, 'boundaryId': boundary_id}

    def recover(self, boundary_id):
        with self.lock:
            key = self.boundaries.get(boundary_id)
            if not self.recovery or not key or key in self.journal.data['recoveryUsed']:
                return {'enabled': False}
            pending = [i for i,c in self.journal.data['claims'].items() if c['state'] != 'completed']
            complete = [i for i,c in self.journal.data['claims'].items() if c['state'] == 'completed']
            context = ('DevFlow transport continuity only. Canonical memory and handoff files remain authoritative for task intent. '
                       'Do not re-post replies or re-execute messages from this metadata. '
                       'Pending delivery IDs (not proof of ingestion): ' + ', '.join(pending[:32]) +
                       '. Completed delivery IDs: ' + ', '.join(complete[-32:]) + '.')[:8192]
            self.journal.update(lambda d: d['recoveryUsed'].append(key))
            return {'enabled': True, 'context': context}


def strict_channel_post(wrapper, claim):
    """Positive server evidence only; warning helpers intentionally fail open.

    The root-turn interval excludes replies while this delivery was merely
    queued, and later unrelated turns. Persisted routing survives wrapper restart.
    """
    from urllib.parse import urlencode
    try:
        channel = claim.get('replyChannel')
        participant = claim.get('participantId')
        start = claim.get('startedAt')
        end = (claim.get('completion') or {}).get('completedAt')
        if not all(isinstance(x, str) and x for x in (channel, participant, start, end)):
            return False
        lower = datetime.fromisoformat(start.replace('Z', '+00:00'))
        upper = datetime.fromisoformat(end.replace('Z', '+00:00'))
        if lower.tzinfo is None or upper.tzinfo is None or upper < lower:
            return False
        result = wrapper.api_call('?' + urlencode({'channelId': channel, 'since': start, 'limit': 200}))
        if not isinstance(result, dict) or result.get('error') or not isinstance(result.get('messages'), list):
            return False
        for message in result['messages']:
            if not isinstance(message, dict): return False
            sender = message.get('from')
            if not isinstance(sender, dict) or sender.get('id') != participant: continue
            timestamp = message.get('timestamp')
            if not isinstance(timestamp, str): return False
            when = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
            if when.tzinfo is None: return False
            if lower <= when <= upper and isinstance(message.get('content'), str) and message['content'].strip():
                return True
        return False
    except Exception:
        return False


class CanaryPump:
    """Exclusive poll-loop owner while native mode or unresolved claims exist."""
    def __init__(self, wrapper, transport):
        self.wrapper, self.transport = wrapper, transport
        self.pending = {}
        self.last_fetch = 0
        self.error = None

    def active(self):
        return self.transport.enabled or self.transport.journal.unresolved()

    def tick(self):
        w, t = self.wrapper, self.transport
        if not w.joined or not w.child or not w.child.isalive(): return
        with t.lock:
            w.is_processing = t.activity == 'working'
            w.broadcast_activity(t.activity)
            for delivery_id, claim in t.reconcile():
                # Text disposition needs a real channel post; silence is deliberate.
                disposition = claim['completion']['disposition']
                if disposition not in ('no_reply', 'empty'):
                    if not strict_channel_post(w, claim): continue
                timestamp = claim.get('timestamp')
                if not timestamp: continue
                result = w.api_call('', 'POST', {'action': 'mark_read', 'channelId': w.channel_id,
                                   'participantId': w.participant_id, 'messageTimestamp': timestamp})
                if not isinstance(result, dict) or result.get('success') is not True: continue
                t.complete(delivery_id)
                w._native_ack_allowed = True
                try:
                    w._track_injected_id(delivery_id)
                    w._save_cursor_timestamp(timestamp)
                    w.last_poll_time = timestamp
                finally: w._native_ack_allowed = False
                w.log_delivery_event(delivery_id, 'delivered')
            if not t.enabled or t.journal.unresolved() or not t.bridge or not t.bridge.instance:
                return
            # Read the server as an authoritative backstop and retain SSE arrivals.
            # Never call check_inbox(), which changes its read flags at enqueue time.
            if time.monotonic() - self.last_fetch >= 2:
                from urllib.parse import urlencode
                query = {'channelId': w.channel_id, 'participantId': w.participant_id, 'limit': 100}
                if w.last_poll_time: query['since'] = w.last_poll_time
                result = w.api_call('?' + urlencode(query))
                self.last_fetch = time.monotonic()
                for msg in result.get('messages', []): self._receive(msg)
            for _ in range(100):
                try: msg = w.sse_message_queue.get_nowait()
                except __import__('queue').Empty: break
                self._receive(msg)
            if t.offer: return
            for delivery_id, msg in sorted(self.pending.items(), key=lambda item: item[1].get('timestamp', '')):
                if delivery_id in t.journal.data['claims']:
                    self.pending.pop(delivery_id, None)
                    continue
                content = msg.get('content', '')
                # Match legacy attachment handling; never silently omit an attachment.
                from importlib import import_module
                download = import_module('collab-claude').download_collab_image
                for url in msg.get('metadata', {}).get('imageUrls', []):
                    local = download(url)
                    content += '\n' + (f'[Attached file: {local}]' if local else f'[ATTACHMENT FAILED TO DOWNLOAD: {url}]')
                mentioned = w.participant_id in msg.get('mentions', []) or bool(re.search(
                    r'@' + re.escape(w.participant_name or '') + r'(?:[^a-zA-Z0-9_-]|$)', content, re.I))
                marker = '(@you)' if mentioned else ('(not addressed to you)' if msg.get('mentions') else '(broadcast)')
                prompt = w._format_injection(msg.get('from', {}).get('name', 'Unknown'), content,
                                             msg.get('replyTo'), w.channel_name or w.channel_id, marker, delivery_id)
                if t.enqueue(delivery_id, prompt, msg.get('timestamp'),
                             reply_channel=import_module('collab-claude').cross_channel_source_id(content) or w.channel_id,
                             participant_id=w.participant_id):
                    self.pending.pop(delivery_id, None)
                break

    def _receive(self, msg):
        w, t = self.wrapper, self.transport
        delivery_id = msg.get('id')
        if not isinstance(delivery_id, str) or not IDENTIFIER.fullmatch(delivery_id): return
        sender = msg.get('from', {}).get('id')
        if sender == w.participant_id: return
        if sender == 'system' and w.participant_id not in msg.get('mentions', []): return
        if msg.get('recipients') and w.participant_id not in msg['recipients']: return
        if w.last_poll_time and msg.get('timestamp', '') <= w.last_poll_time: return
        if delivery_id in t.journal.data['claims'] or delivery_id in w.injected_message_ids: return
        if len(self.pending) >= 1024: raise DeliveryBlocked('native inbox full')
        self.pending.setdefault(delivery_id, msg)


def _is_canary(wrapper):
    """True only for the one agent named in this installation's .AppData/claude-mod-canary.json
    ({"participant": ..., "channel": ..., "cwd": ...}). No file, no canary."""
    try:
        home = Path(os.environ.get('DEVFLOW_HOME') or str(Path.home() / 'DevFlow'))
        target = json.loads((home / '.AppData' / 'claude-mod-canary.json').read_text(encoding='utf-8'))
        return (wrapper.participant_name == target['participant']
                and wrapper.channel_id == target['channel']
                and Path.cwd().resolve() == Path(target['cwd']).resolve())
    except (OSError, ValueError, KeyError, TypeError):
        return False


def make_pump(wrapper, environ):
    enabled = environ.get('DEVFLOW_CLAUDE_MOD_DELIVERY') == '1'
    recovery = environ.get('DEVFLOW_CLAUDE_MOD_RECOVERY') == '1'
    canary = _is_canary(wrapper)
    enabled, recovery = enabled and canary, recovery and canary
    key = hashlib.sha256(((wrapper.channel_id or '') + ':' + (wrapper.participant_name or '')).encode()).hexdigest()[:24]
    path = Path.cwd() / '.session-scratch' / ('devflow-native-' + key + '.json')
    if not enabled and not recovery and not path.exists(): return None
    journal = ClaimJournal(path)
    # Completion can be durable before the legacy dedup cache/cursor is flushed.
    # Restore tombstones on every launch, including opt-out, before poll threads.
    for delivery_id, claim in journal.data['claims'].items():
        if claim['state'] == 'completed':
            wrapper._track_injected_id(delivery_id)
    return CanaryPump(wrapper, NativeTransport(journal, enabled, recovery))
