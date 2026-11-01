'use client';

import { useState, type FormEvent } from 'react';
import styles from './ProviderKeyForm.module.css';
import { keyProvider, resumeDestination } from './provider-link';

export function ProviderKeyForm({ providerId }: { providerId: string }) {
  const provider = keyProvider(providerId);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [saved, setSaved] = useState(false);
  if (!provider) return null;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!provider || saving || !value.trim()) return;
    if (value.trim().length > 8192 || /[\u0000-\u0020\u007f]/.test(value.trim())) {
      setMessage('Enter a key without spaces or line breaks.');
      return;
    }
    setSaving(true);
    setMessage('');
    setSaved(false);
    try {
      const response = await fetch('/api/vault/sync-secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', secret: { name: provider.secretName, value: value.trim(), type: 'text' } }),
      });
      const result = await response.json();
      if (!response.ok || result.success !== true) throw new Error('save');
      // The API can skip invalid values. Confirm persistence before leaving the form.
      const check = await fetch('/api/vault/sync-secrets', { cache: 'no-store' });
      const status = await check.json();
      if (!check.ok || status.success !== true || !status.envVars?.includes(provider.secretName)) throw new Error('verify');
      setValue('');
      setSaved(true);
      const params = new URLSearchParams(window.location.search);
      const destination = params.get('provider') === provider.id ? resumeDestination(window.location.search) : null;
      if (destination) window.location.assign(destination);
      else setMessage('Key saved. Return to the feature to choose your model.');
    } catch {
      setMessage('Could not confirm the key was saved. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="conn-detail__content" onSubmit={save}>
      <p>Save your {provider.label} API key to return to your model choice. Saving a key does not enable a feature.</p>
      <label className="conn-detail__section-label" htmlFor="provider-api-key">{provider.label} API key</label>
      <input
        id="provider-api-key"
        className={styles.input}
        type="password" autoComplete="off" spellCheck={false} required maxLength={8192}
        pattern="[^\s]+" value={value} disabled={saving}
        onChange={event => { setValue(event.target.value); setMessage(''); setSaved(false); }}
      />
      <div>
        <button className="conn-detail__test-btn" type="submit" disabled={saving || !value.trim()}>
          {saving ? 'Saving…' : 'Save key'}
        </button>
      </div>
      {message && <p role={saved ? 'status' : 'alert'}>{message}</p>}
    </form>
  );
}
