'use client';

import { useState } from 'react';
import { Power } from 'lucide-react';

export function DisconnectButton() {
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function disconnect() {
    if (disconnecting) return;
    setDisconnecting(true);
    setError(null);
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST' });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.detail ?? `Could not disconnect (HTTP ${response.status}).`);
      }
      window.location.assign('/');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not disconnect the Azure account.');
      setDisconnecting(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        className="inline-flex items-center gap-2 rounded-xl border border-rose-500/80 bg-rose-950/50 px-4 py-2 text-sm font-medium text-rose-200 transition hover:bg-rose-900/50 disabled:cursor-not-allowed disabled:opacity-60"
        disabled={disconnecting}
        onClick={() => void disconnect()}
      >
        <Power size={20} className="text-rose-400" aria-hidden="true" />
        {disconnecting ? 'Disconnecting...' : 'Disconnect'}
      </button>
      {error && <span role="alert" className="text-xs text-red-300">{error}</span>}
    </div>
  );
}
