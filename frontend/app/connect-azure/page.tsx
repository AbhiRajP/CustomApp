'use client';

import { useCallback, useEffect, useState } from 'react';
import { DisconnectButton } from '@/components/disconnect-button';
import { AzureConnectionLoader } from '@/components/azure-connection-loader';
import Image from 'next/image';
import { ArrowRight, BarChart3, LayoutGrid, Layers } from 'lucide-react';

type AzureSubscription = {
  id: string;
  name: string;
  state: string;
};
type Preferences = { subscriptionId: string | null };
type AuthStatus = { configured: boolean; connected: boolean; tenantId: string | null };

const emptyPreferences: Preferences = { subscriptionId: null };

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.detail ?? `Request failed (${response.status}).`);
  return payload as T;
}

export default function ConnectAzurePage() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [subscriptions, setSubscriptions] = useState<AzureSubscription[]>([]);
  const [preferences, setPreferences] = useState<Preferences>(emptyPreferences);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadConnectedData = useCallback(async () => {
    const [subscriptionResponse, savedPreferences] = await Promise.all([
      apiRequest<{ items: AzureSubscription[] }>('/api/subscriptions'),
      apiRequest<Preferences>('/api/preferences'),
    ]);
    setSubscriptions(subscriptionResponse.items);
    setPreferences(savedPreferences);
  }, []);

  const refreshAuth = useCallback(async () => {
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const status = await apiRequest<AuthStatus>('/api/auth/status');
      setAuth(status);
      if (status.connected) {
        await loadConnectedData();
        setNotice('Azure connection is ready. Select a subscription to monitor.');
      } else {
        setSubscriptions([]);
        setPreferences(emptyPreferences);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not load Azure connection.');
    } finally {
      setLoading(false);
    }
  }, [loadConnectedData]);

  useEffect(() => {
    void refreshAuth();
  }, [refreshAuth]);

  async function savePreferences() {
    if (!preferences.subscriptionId) {
      setError('Select a subscription first.');
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await apiRequest<Preferences>('/api/preferences', {
        method: 'PUT',
        body: JSON.stringify(preferences),
      });
      setPreferences(saved);
      setNotice('Subscription preference saved for your Azure tenant.');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not save your subscription preference.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="landing-page relative isolate min-h-screen overflow-hidden px-4 py-6 sm:px-8 sm:py-8 lg:px-12">
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-48 w-full sm:h-64"
        viewBox="0 0 1600 300"
        preserveAspectRatio="none"
      >
        <path d="M0 180 C240 35 360 125 570 200 S900 180 1100 110 S1400 200 1600 55" fill="none" stroke="#0878d1" strokeOpacity=".5" strokeWidth="2" />
        <path d="M0 235 C250 90 430 285 700 245 S1120 75 1320 135 S1510 140 1600 105" fill="none" stroke="#168fe5" strokeOpacity=".28" strokeWidth="2" />
      </svg>
      <div className="mx-auto w-full max-w-[1920px]">
        <div className="relative mb-9 block h-[68px] w-[340px] max-w-full overflow-hidden sm:mb-10">
          <Image
            src="/cloud-grid-logo.png"
            alt="Cloud Grid"
            width={2172}
            height={724}
            priority
            className="absolute left-1/2 top-1/2 h-auto w-[133%] max-w-none -translate-x-1/2 -translate-y-1/2 mix-blend-lighten"
          />
        </div>

        <section className="relative mt-8 overflow-hidden rounded-[24px] border-2 border-cyan-400 bg-[radial-gradient(ellipse_at_82%_100%,rgba(0,148,255,0.2),transparent_38%),linear-gradient(110deg,rgba(3,38,70,0.98),rgba(4,26,54,0.97)_58%,rgba(2,17,37,0.98))] px-6 py-6 shadow-[0_16px_50px_rgba(0,140,255,0.1)] sm:px-8 sm:py-7 lg:px-10 lg:py-8">
          <div className="relative z-10 max-w-6xl">
            <p className="text-sm font-bold uppercase tracking-wide text-cyan-300">Customer onboarding</p>
            <h1 className="mt-1.5 text-4xl font-bold tracking-tight text-white sm:text-5xl">Connect Azure</h1>
            <p className="mt-2 max-w-6xl text-sm leading-6 text-slate-100 sm:text-base">
              Connect your tenant and select a subscription. Costs and resource inventory are shown for that subscription.
            </p>
          </div>
          <svg aria-hidden="true" className="pointer-events-none absolute bottom-0 right-0 h-20 w-[55%] sm:h-24" viewBox="0 0 720 130" fill="none" preserveAspectRatio="none">
            <defs>
              <linearGradient id="onboarding-wave-fill" x1="0" y1="0" x2="720" y2="130" gradientUnits="userSpaceOnUse">
                <stop stopColor="#0787e8" stopOpacity=".04" />
                <stop offset="1" stopColor="#0787e8" stopOpacity=".34" />
              </linearGradient>
            </defs>
            <path d="M0 129C105 108 175 43 275 45c112 2 156 78 260 65 74-9 111-51 185-84v104H0Z" fill="url(#onboarding-wave-fill)" />
            <path d="M0 129C105 108 175 43 275 45c112 2 156 78 260 65 74-9 111-51 185-84" stroke="#08bdf5" strokeOpacity=".65" strokeWidth="2" />
          </svg>
        </section>

        {error && <div role="alert" className="mt-5 rounded-xl border border-red-800 bg-red-950/70 p-4 text-red-200">{error}</div>}
        {notice && <div role="status" className="mt-5 rounded-xl border border-emerald-800 bg-emerald-950/60 p-4 text-emerald-200">{notice}</div>}

        <section className="mt-7 grid gap-6 rounded-[24px] border border-sky-400/50 bg-slate-900/55 p-6 shadow-[0_20px_70px_rgba(0,0,0,0.2)] backdrop-blur sm:p-8 lg:grid-cols-[minmax(0,1.8fr)_minmax(280px,0.9fr)] lg:gap-10">
          <div className="flex flex-col justify-center">
            {loading ? (
              <AzureConnectionLoader />
            ) : auth?.connected ? (
              <>
                <div className="flex items-center gap-3">
                  <span aria-hidden="true" className="grid grid-cols-2 gap-0.5 rounded-sm bg-white p-1 shadow-sm">
                    <span className="h-3 w-3 bg-[#f25022]" />
                    <span className="h-3 w-3 bg-[#7fba00]" />
                    <span className="h-3 w-3 bg-[#00a4ef]" />
                    <span className="h-3 w-3 bg-[#ffb900]" />
                  </span>
                  <h2 className="text-2xl font-semibold text-white sm:text-3xl">Azure account connected</h2>
                </div>
                <p className="mt-3 text-sm text-slate-300">Tenant ID: {auth.tenantId}</p>
                <label className="mt-5 block max-w-2xl text-sm font-medium text-slate-200">
                  Azure subscription
                  <select
                    className="mt-2 w-full rounded-xl border border-slate-600 bg-slate-950/80 px-4 py-3 text-white focus:border-cyan-400 focus:outline-none"
                    value={preferences.subscriptionId ?? ''}
                    onChange={(event) => {
                      setPreferences({ subscriptionId: event.target.value || null });
                      setNotice(null);
                    }}
                  >
                    <option value="">Select a subscription</option>
                    {subscriptions.map((subscription) => (
                      <option key={subscription.id} value={subscription.id}>
                        {subscription.name} ({subscription.state})
                      </option>
                    ))}
                  </select>
                </label>
                <div className="mt-5 flex flex-wrap gap-3">
                  <button className="primary-button" disabled={saving || !preferences.subscriptionId} onClick={() => void savePreferences()}>
                    {saving ? 'Saving...' : 'Save subscription'}
                  </button>
                  <a className="secondary-button" href="/">Open cost dashboard</a>
                  <button className="secondary-button" disabled={loading} onClick={() => void refreshAuth()}>Refresh</button>
                  <DisconnectButton />
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-3">
                  <span aria-hidden="true" className="grid grid-cols-2 gap-0.5 rounded-sm bg-white p-1 shadow-sm">
                    <span className="h-5 w-5 bg-[#f25022]" />
                    <span className="h-5 w-5 bg-[#7fba00]" />
                    <span className="h-5 w-5 bg-[#00a4ef]" />
                    <span className="h-5 w-5 bg-[#ffb900]" />
                  </span>
                  <h2 className="text-2xl font-semibold text-white sm:text-3xl">Sign in with Microsoft Entra</h2>
                </div>
                <p className="mt-4 max-w-3xl text-sm leading-6 text-slate-200 sm:text-base">
                  Sign in and grant read access so the app can list subscriptions, resources, and query Azure costs.
                </p>
                {auth?.configured ? (
                  <a
                    className="mt-7 inline-flex min-h-14 w-fit items-center justify-between gap-5 rounded-full bg-gradient-to-r from-cyan-500 to-blue-600 px-5 text-base font-semibold text-white shadow-lg shadow-blue-950/40 transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 sm:px-6"
                    href="/api/auth/login"
                  >
                    <span>Sign in and connect Azure</span>
                    <ArrowRight size={22} aria-hidden="true" />
                  </a>
                ) : (
                  <p className="mt-6 max-w-2xl rounded-xl border border-amber-700 bg-amber-950/50 p-4 text-sm text-amber-200">
                    Azure sign-in is not configured yet. Set the required backend environment variables described in
                    <code className="mx-1">backend/.env.example</code>, register the callback URL in Microsoft Entra, and restart the API.
                  </p>
                )}
              </>
            )}
          </div>

          <aside className="grid content-center gap-3 border-t border-sky-400/30 pt-6 lg:border-l lg:border-t-0 lg:pl-10 lg:pt-0">
            {[
              { icon: Layers, title: 'View Subscriptions', detail: 'List and select your Azure subscriptions' },
              { icon: BarChart3, title: 'Analyze Costs', detail: 'Monitor and compare Azure spending' },
              { icon: LayoutGrid, title: 'Explore Resources', detail: 'View your resources and inventory' },
            ].map(({ icon: Icon, title, detail }) => (
              <div key={title} className="flex items-center gap-4">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-sky-400/20 bg-sky-500/10 text-cyan-300">
                  <Icon size={27} aria-hidden="true" />
                </span>
                <div>
                  <h3 className="font-semibold text-white">{title}</h3>
                  <p className="mt-0.5 text-sm text-slate-300">{detail}</p>
                </div>
              </div>
            ))}
          </aside>
        </section>
      </div>
    </main>
  );
}
