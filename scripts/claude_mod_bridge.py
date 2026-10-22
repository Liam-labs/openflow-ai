"""Per-child authenticated Claude mod bridge.

Observer-only by default. Optional native controller is attached exclusively for
the authorised disposable canary, with independent delivery and recovery gates.
"""
import collections
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import threading
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs
import uuid

ID = re.compile(r'^[A-Za-z0-9:_-]{1,200}$')
IDENTITY = {'version', 'generation', 'instanceId', 'rootSessionId'}
EVENT_FIELDS = {
    'session.start': set(), 'session.end': {'reason'},
    'turn.start': {'turnId', 'deliveryIds'},
    'turn.complete': {'turnId', 'deliveryIds', 'isAborted', 'reason', 'disposition'},
    'tool.start': {'turnId', 'tool'},
    'tool.complete': {'turnId', 'tool', 'failed'},
    'session.boundary': {'source'},
    **{name: {'deliveryId'} for name in ('delivery.submitting', 'delivery.submitted', 'delivery.dropped', 'delivery.uncertain')},
}
MAX_BODY = 65536


class BridgeError(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code


def fail(status, code):
    raise BridgeError(status, code)


def valid_id(value):
    return isinstance(value, str) and bool(ID.fullmatch(value))


class ObserverBridge:
    def __init__(self, root_session_id, evidence_path=None, native=None):
        if not valid_id(root_session_id):
            raise ValueError('invalid root session')
        self.native = native
        self.evidence_path = Path(evidence_path) if evidence_path else None
        self.root = root_session_id
        self.token = secrets.token_urlsafe(32)
        self.generation = uuid.uuid4().hex
        self.instance = None
        self.sequence = 0
        self.events = collections.deque(maxlen=256)
        self.seen = collections.OrderedDict()
        self.checkpoint = None
        self.lock = threading.Lock()
        self.server = None
        self.thread = None

    def _identity(self, headers, body, registering=False):
        if not hmac.compare_digest(headers.get('Authorization', ''), 'Bearer ' + self.token):
            fail(401, 'unauthorized')
        if headers.get('X-DevFlow-Generation') != self.generation:
            fail(409, 'stale_generation')
        instance = headers.get('X-DevFlow-Instance')
        if not valid_id(instance) or headers.get('X-DevFlow-Root-Session') != self.root:
            fail(409, 'wrong_identity')
        if body is not None:
            if type(body.get('version')) is not int or body['version'] != 1:
                fail(400, 'unsupported_version')
            if any(body.get(k) != v for k, v in [('generation', self.generation), ('instanceId', instance), ('rootSessionId', self.root)]):
                fail(409, 'wrong_identity')
        if not registering and instance != self.instance:
            fail(409, 'unregistered_instance')
        return instance

    def dispatch(self, method, path, headers, body=None):
        with self.lock:
            route = urlsplit(path).path
            if body is not None and not isinstance(body, dict):
                fail(400, 'invalid_json_object')
            instance = self._identity(headers, body, method == 'POST' and route == '/register')
            if method == 'POST' and route == '/register':
                if set(body) != IDENTITY:
                    fail(400, 'invalid_registration')
                if self.instance not in (None, instance):
                    fail(409, 'instance_replacement_disabled')
                self.instance = instance
                self._save_evidence()
                return {'accepted': True}
            if method == 'GET' and route == '/next':
                return self.native.next() if self.native else {'mode': 'observe'}
            if method == 'GET' and route == '/recovery':
                # No boundary verifier/recovery injector is connected in observer mode.
                boundary = parse_qs(urlsplit(path).query).get('boundaryId', [''])[0]
                return self.native.recover(boundary) if self.native else {'enabled': False}
            if method == 'POST' and route == '/checkpoint':
                if set(body) - (IDENTITY | {'turnId', 'deliveryIds'}):
                    fail(400, 'invalid_checkpoint')
                self._fields(body)
                # Bounded observation only; never an authoritative delivery checkpoint.
                self.checkpoint = {k: body[k] for k in ('turnId', 'deliveryIds') if k in body}
                self._save_evidence()
                return {'accepted': True}
            if method == 'POST' and route == '/events':
                event = body.get('event')
                if isinstance(event, str) and event.startswith('delivery.') and not self.native:
                    fail(409, 'native_delivery_disabled')
                if not isinstance(event, str) or event not in EVENT_FIELDS or set(body) - (IDENTITY | {'sequence', 'event'} | EVENT_FIELDS[event]):
                    fail(400, 'invalid_event')
                seq = body.get('sequence')
                if type(seq) is not int or not 0 < seq < 2**53:
                    fail(400, 'invalid_sequence')
                self._fields(body)
                serialized = json.dumps(body, sort_keys=True, separators=(',', ':'))
                if seq in self.seen:
                    if self.seen[seq] != serialized:
                        fail(409, 'conflicting_sequence')
                    return {'accepted': True, 'submit': False} if event == 'delivery.submitting' else {'accepted': True}
                if seq <= self.sequence:
                    fail(409, 'stale_sequence')
                result = {'accepted': True}
                if self.native:
                    try:
                        result = (self.native.boundary(body['source']) if event == 'session.boundary'
                                  else self.native.event(body))
                    except Exception as exc:
                        fail(getattr(exc, 'status', 503), 'native_state_unavailable')
                self.sequence = seq
                self.seen[seq] = serialized
                if len(self.seen) > 256:
                    self.seen.popitem(last=False)
                self.events.append(dict(body))
                self._save_evidence()
                return result
            fail(404, 'unknown_endpoint')

    def _save_evidence(self):
        # Optional bounded private observer evidence, never a delivery journal.
        if not self.evidence_path:
            return
        tmp = None
        try:
            self.evidence_path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(prefix='.mod-observer-', dir=self.evidence_path.parent)
            with os.fdopen(fd, 'w') as f:
                json.dump({'generation': self.generation, 'rootSessionId': self.root,
                           'instanceId': self.instance, 'events': list(self.events),
                           'checkpoint': self.checkpoint}, f)
            os.replace(tmp, self.evidence_path)
        except OSError:
            pass  # Observational evidence cannot fail a tool/turn or alter delivery.
        finally:
            if tmp and os.path.exists(tmp):
                os.unlink(tmp)

    @staticmethod
    def _fields(body):
        if 'turnId' in body and body['turnId'] is not None and not valid_id(body['turnId']):
            fail(400, 'invalid_turn')
        if (str(body.get('event', '')).startswith('delivery.') or 'deliveryId' in body) and not valid_id(body.get('deliveryId')):
            fail(400, 'invalid_delivery_id')
        if body.get('event') in ('turn.start', 'turn.complete') and not valid_id(body.get('turnId')):
            fail(400, 'missing_turn')
        ids = body.get('deliveryIds', [])
        if not isinstance(ids, list) or len(ids) > 32 or any(not valid_id(v) for v in ids):
            fail(400, 'invalid_delivery_ids')
        for key in ('isAborted', 'failed'):
            if key in body and type(body[key]) is not bool:
                fail(400, 'invalid_flag')
        if 'tool' in body and (not isinstance(body['tool'], str) or not re.fullmatch(r'[A-Za-z0-9_.:/-]{1,128}', body['tool'])):
            fail(400, 'invalid_tool')
        if 'disposition' in body and body['disposition'] not in ('no_reply', 'empty', 'text', 'unknown'):
            fail(400, 'invalid_disposition')
        if 'reason' in body and (not isinstance(body['reason'], str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,64}', body['reason'])):
            fail(400, 'invalid_reason')
        if 'source' in body and body['source'] not in ('compact', 'resume'):
            fail(400, 'invalid_boundary')

    def start(self):
        bridge = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def setup(self):
                super().setup()
                self.connection.settimeout(2)

            def handle_request(self):
                try:
                    # Authenticate before parsing bodies. Reject browser-origin requests.
                    if self.headers.get('Origin'):
                        fail(403, 'origin_not_allowed')
                    if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + bridge.token):
                        fail(401, 'unauthorized')
                    body = None
                    if self.command == 'POST':
                        if self.headers.get('Transfer-Encoding') or self.headers.get_content_type() != 'application/json':
                            fail(400, 'invalid_content_type')
                        try:
                            n = int(self.headers.get('Content-Length', '0'))
                        except ValueError:
                            fail(400, 'invalid_length')
                        if n > MAX_BODY:
                            fail(413, 'payload_too_large')
                        if n <= 0:
                            fail(400, 'invalid_length')
                        try:
                            body = json.loads(self.rfile.read(n))
                        except (ValueError, UnicodeError):
                            fail(400, 'invalid_json')
                    value = bridge.dispatch(self.command, self.path, self.headers, body)
                    status = 200
                except BridgeError as e:
                    status, value = e.status, {'accepted': False, 'error': e.code}
                except Exception:
                    status, value = 503, {'accepted': False, 'error': 'bridge_unavailable'}
                data = json.dumps(value).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                try:
                    self.wfile.write(data)
                except OSError:
                    pass

            do_GET = do_POST = handle_request

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': 0.05}, daemon=True)
        self.thread.start()
        return self

    def child_env(self, original):
        return {**original, 'DEVFLOW_MOD_BRIDGE_URL': f'http://127.0.0.1:{self.server.server_port}',
                'DEVFLOW_MOD_BRIDGE_TOKEN': self.token, 'DEVFLOW_MOD_BRIDGE_GENERATION': self.generation}

    def close(self):
        if self.server:
            self.server.shutdown()
            self.server.server_close()
            self.thread.join(timeout=2)
            self.server = None


def prepare_observer(args, environ, native=None):
    """Return (argv, child environment, bridge). No plugin or listener by default.

    Pin fresh sessions with --session-id; explicit UUID resumes retain their ID.
    Ambiguous interactive resume/continue stays on the legacy path, without mods.
    """
    if environ.get('DEVFLOW_CLAUDE_MOD_OBSERVE') != '1' and not (native and (native.enabled or native.recovery)):
        return args, None, None
    argv = list(args)
    root = None
    for i, arg in enumerate(argv):
        if arg in ('--continue', '-c', '--fork-session'):
            return args, None, None
        if arg in ('--session-id', '--resume', '-r'):
            root = argv[i + 1] if i + 1 < len(argv) else ''
        elif arg.startswith(('--session-id=', '--resume=')):
            root = arg.split('=', 1)[1]
    if root is not None:
        try:
            root = str(uuid.UUID(root))
        except (ValueError, AttributeError):
            return args, None, None
    else:
        root = str(uuid.uuid4())
        argv += ['--session-id', root]
    plugin = Path(__file__).resolve().parent / 'claude-mods' / 'devflow-bridge'
    if not (plugin / '.claude-plugin' / 'plugin.json').is_file():
        return args, None, None
    bridge = ObserverBridge(root, Path.cwd() / ".session-scratch" / "devflow-mod-observer.json", native=native)
    if native:
        project = str(Path.cwd()).replace('/', '-')
        transcript = Path.home() / '.claude' / 'projects' / project / (root + '.jsonl')
        native.attach(bridge, transcript, resume=any(a in ('--resume', '-r') or a.startswith('--resume=') for a in args))
    try:
        bridge.start()
        argv += ['--plugin-dir', str(plugin)]
        return argv, bridge.child_env(environ), bridge
    except Exception:
        bridge.close()
        return args, None, None
