import hashlib
import importlib.util
import json
from pathlib import Path
import time

import pytest

SCRIPT = Path(__file__).parents[2]/'data/skills/tripo-image-to-3d/scripts/tripo.py'
spec = importlib.util.spec_from_file_location('tripo_workflow', SCRIPT)
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)

@pytest.fixture
def plan(tmp_path):
    image = tmp_path/'reference.png'
    image.write_bytes(b'synthetic-reviewed-image')
    guide = tmp_path/'guide.md'; guide.write_text('Choose a suitable route for this asset.')
    decision = tmp_path/'decision.json'
    decision.write_text(json.dumps(t._decision.record(guide,image,'tripo',
        'Complex detailed static prop', 'Procedural route needs more sculpting', 'static prop')))
    p = tmp_path/'plan.json'
    p.write_text(json.dumps({'image':str(image),'decision':str(decision),'image_sha256':hashlib.sha256(image.read_bytes()).hexdigest(),
        'model':'P2-20260801','face_limit':20000,'texture':True,'pbr':True,'texture_quality':'standard',
        'estimated_credits':50,'credit_limit':50,'quote_source':'https://example.test/fixture-price',
        'quote_checked_at':time.time(),'design_reviewed':True,'license_confirmed':True}))
    return p

@pytest.mark.parametrize('field,value', [('design_reviewed',False),('license_confirmed',False),
                                        ('estimated_credits',51),('quote_checked_at',1),
                                        ('texture_quality','extreme'),('model','unpriced')])
def test_bad_plan_never_calls_provider(plan,monkeypatch,field,value):
    data=json.loads(plan.read_text());data[field]=value;plan.write_text(json.dumps(data))
    monkeypatch.setattr(t,'request',lambda *a: pytest.fail('provider call on invalid plan'))
    with pytest.raises(t.Failure): t.submit(plan,plan.parent/'ledger.json')


def test_changed_reference_needs_review_again(plan):
    Path(json.loads(plan.read_text())['image']).write_bytes(b'changed')
    with pytest.raises(t.Failure,match='image_changed'):t.plan_asset(plan)


def test_no_credit_never_uploads_or_submits(plan,monkeypatch):
    calls=[]
    def fake(method,path,*args):
        calls.append((method,path));return {'balance':0,'frozen':0}
    monkeypatch.setattr(t,'request',fake)
    with pytest.raises(t.Failure,match='insufficient_credits'):t.submit(plan,plan.parent/'ledger.json')
    assert calls==[('GET','/account/balance')]
    assert not (plan.parent/'ledger.json').exists()


def test_submission_is_once_and_ledger_retains_task(plan,monkeypatch):
    calls=[]
    def fake(method,path,*args):
        calls.append((method,path))
        return {'/account/balance':{'balance':100,'frozen':0},'/files':{'file_token':'synthetic'},
                '/generation/image-to-model':{'task_id':'task_fixture'}}[path]
    monkeypatch.setattr(t,'request',fake)
    ledger=plan.parent/'ledger.json'
    assert t.submit(plan,ledger)['task_id']=='task_fixture'
    with pytest.raises(t.Failure,match='already_reserved'):t.submit(plan,ledger)
    assert calls.count(('POST','/generation/image-to-model'))==1
    assert 'synthetic' not in ledger.read_text()


def test_lost_response_does_not_retry(plan,monkeypatch):
    calls=[]
    def fake(method,path,*args):
        calls.append(path)
        if path=='/account/balance':return {'balance':100,'frozen':0}
        if path=='/files':return {'file_token':'synthetic'}
        raise t.Failure('network_or_response_unknown')
    monkeypatch.setattr(t,'request',fake)
    ledger=plan.parent/'ledger.json'
    result=t.submit(plan,ledger)
    assert result['state']=='outcome_unknown' and result['generation_submitted'] is None
    with pytest.raises(t.Failure,match='already_reserved'):t.submit(plan,ledger)
    assert calls.count('/generation/image-to-model')==1


def test_balance_only_returns_numeric_allowlist(monkeypatch):
    monkeypatch.setattr(t,'request',lambda *a:{'balance':100,'frozen':1,'extra':'do-not-return'})
    assert 'extra' not in t.balance()


def test_changed_decision_guide_blocks_before_balance(plan,monkeypatch):
    (plan.parent/'guide.md').write_text('Changed route requirements')
    monkeypatch.setattr(t,'request',lambda *a: pytest.fail('provider request before decision review'))
    with pytest.raises(t.Failure,match='decision_required_or_stale'):
        t.submit(plan,plan.parent/'ledger.json')
