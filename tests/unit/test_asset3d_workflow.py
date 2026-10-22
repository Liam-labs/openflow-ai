import importlib.util
import json
from pathlib import Path
import sys
import time

import pytest

SCRIPTS = Path(__file__).parents[2]/'data/skills/asset3d-workflow/scripts'
spec = importlib.util.spec_from_file_location('decision',SCRIPTS/'decision.py')
decision = importlib.util.module_from_spec(spec); spec.loader.exec_module(decision)
sys.modules['decision'] = decision
spec = importlib.util.spec_from_file_location('fal_trellis',SCRIPTS/'fal_trellis.py')
fal = importlib.util.module_from_spec(spec); spec.loader.exec_module(fal)


@pytest.fixture
def plan(tmp_path,monkeypatch):
    image=tmp_path/'ref.png'; image.write_bytes(b'fixture-image')
    guide=tmp_path/'guide.md'; guide.write_text('Evaluate our asset requirements first.')
    d=tmp_path/'decision.json'
    d.write_text(json.dumps(decision.record(guide,image,'fal-trellis2',
        'Detailed static asset matching concept', 'Manual sculpt requires extra work', 'static prop')))
    p=tmp_path/'plan.json'
    p.write_text(json.dumps(dict(image=str(image),decision=str(d),resolution='1024',seed=42,
        estimated_usd=0.30,limit_usd=0.30,quote_checked_at=time.time(),
        quote_source='https://fal.ai/models/fal-ai/trellis-2',funding_confirmed=True,
        license_confirmed=True,design_reviewed=True)))
    monkeypatch.setenv('FAL_KEY','non-secret-test-fixture')
    return p


@pytest.mark.parametrize('change',['image','guide','provider','decision_missing','unfunded','price','expired'])
def test_invalid_review_blocks_every_provider_call(plan,monkeypatch,change):
    p=json.loads(plan.read_text())
    if change=='image': Path(p['image']).write_bytes(b'changed')
    elif change=='guide': (plan.parent/'guide.md').write_text('Changed guidance')
    elif change=='decision_missing': Path(p['decision']).unlink()
    elif change=='provider':
        d=json.loads(Path(p['decision']).read_text()); d['provider']='tripo'
        Path(p['decision']).write_text(json.dumps(d))
    else:
        if change=='unfunded': p['funding_confirmed']=False
        if change=='price': p['limit_usd']=0.10
        if change=='expired': p['quote_checked_at']=1
        plan.write_text(json.dumps(p))
    monkeypatch.setattr(fal,'request',lambda *args: pytest.fail('network before checks'))
    with pytest.raises((fal.Failure,ValueError,OSError)):
        fal.submit(plan,plan.parent/'job.json')
    assert not (plan.parent/'job.json').exists()


def test_submit_once_and_resume_without_resubmitting(plan,monkeypatch):
    calls=[]
    def request(method,url,body=None):
        calls.append(method)
        return {'request_id':'fixture-task'} if method=='POST' else {'status':'COMPLETED'}
    monkeypatch.setattr(fal,'request',request)
    ledger=plan.parent/'job.json'
    assert fal.submit(plan,ledger)['task_id']=='fixture-task'
    assert fal.status(ledger)['state']=='COMPLETED'
    with pytest.raises(fal.Failure,match='already_reserved'): fal.submit(plan,ledger)
    assert calls==['POST','GET']
    assert 'fixture-image' not in ledger.read_text()
    assert 'non-secret-test-fixture' not in ledger.read_text()


def test_unknown_submission_is_never_replayed(plan,monkeypatch):
    calls=[]
    def request(*args):
        calls.append(1); raise fal.Failure('network_or_response_unknown')
    monkeypatch.setattr(fal,'request',request)
    ledger=plan.parent/'job.json'
    assert fal.submit(plan,ledger)['state']=='outcome_unknown'
    with pytest.raises(fal.Failure,match='already_reserved'): fal.submit(plan,ledger)
    assert calls==[1]


def test_result_url_cannot_redirect_credential(plan,monkeypatch):
    monkeypatch.setattr(fal,'request',lambda *a: {'request_id':'fixture-task',
        'status_url':'https://evil.example/steal'})
    ledger=plan.parent/'job.json'
    assert fal.submit(plan,ledger)['state']=='outcome_unknown'
    assert 'evil.example' not in ledger.read_text()


def test_collect_does_not_claim_existing_unrelated_model(plan,monkeypatch):
    monkeypatch.setattr(fal,'request',lambda *a: {'request_id':'fixture-task'})
    ledger=plan.parent/'job.json'; fal.submit(plan,ledger)
    monkeypatch.setattr(fal,'status',lambda *a: {'state':'COMPLETED'})
    monkeypatch.setattr(fal,'request',lambda *a: {'model_glb':{'url':'https://files.fal.media/example.glb'}})
    out=plan.parent/'output'; out.mkdir()
    target=out/'generated-master.glb'; target.write_bytes(b'another asset')
    with pytest.raises(fal.Failure,match='output_exists'):
        fal.collect(ledger,out)
    assert target.read_bytes()==b'another asset'


def test_collect_rejects_non_glb_download(plan,monkeypatch):
    import io
    monkeypatch.setattr(fal,'request',lambda *a: {'request_id':'fixture-task'})
    ledger=plan.parent/'job.json'; fal.submit(plan,ledger)
    monkeypatch.setattr(fal,'status',lambda *a: {'state':'COMPLETED'})
    monkeypatch.setattr(fal,'request',lambda *a: {'model_glb':{'url':'https://files.fal.media/example.glb'}})
    class Opener:
        def open(self,*a,**kw): return io.BytesIO(b'<html>download failed</html>')
    monkeypatch.setattr(fal.urllib.request,'build_opener',lambda *a: Opener())
    out=plan.parent/'output'
    with pytest.raises(fal.Failure,match='invalid_glb'):
        fal.collect(ledger,out)
    assert not (out/'generated-master.glb').exists()
