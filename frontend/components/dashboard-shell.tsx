'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { DisconnectButton } from './disconnect-button';
import { AzureConnectionLoader } from './azure-connection-loader';
import { fetchWithTimeout } from '@/lib/api';
import {
  ArrowRight,
  ArrowLeftRight,
  BarChart3,
  Boxes,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Database,
  Download,
  Layers,
  Loader2,
  Server,
  Settings,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';

type AuthStatus = {
  configured: boolean;
  connected: boolean;
  tenantId: string | null;
  costCacheScope: string | null;
};
type Preferences = { subscriptionId: string | null };
type CostData = {
  total: number;
  currency: string;
  range: { from: string; to: string };
  trend: { period: string; cost: number }[];
  byService: { name: string; cost: number }[];
  serviceTrend?: { period: string; services: { name: string; cost: number }[] }[];
  serviceResourceTrend?: {
    period: string;
    services: { name: string; resources: { resourceId: string; cost: number }[] }[];
  }[];
};

const liveCostCache = new Map<string, CostData>();
const LIVE_COST_CACHE_LIMIT = 5;
const SERVICES_PER_PAGE = 10;

function liveCostCacheKey(
  accountScope: string,
  subscriptionId: string,
  startDate: string,
  endDate: string,
): string {
  return JSON.stringify([accountScope, subscriptionId, startDate, endDate, 'Daily', false, 'service-resource-breakdown']);
}

function cacheLiveCosts(key: string, data: CostData): void {
  liveCostCache.delete(key);
  liveCostCache.set(key, data);
  while (liveCostCache.size > LIVE_COST_CACHE_LIMIT) {
    const oldestKey = liveCostCache.keys().next().value;
    if (oldestKey === undefined) break;
    liveCostCache.delete(oldestKey);
  }
}

function dateOffset(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function startOfCurrentMonth(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`;
}

async function apiRequest<T>(url: string): Promise<T> {
  const response = await fetchWithTimeout(url);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.detail ?? `Request failed (${response.status}).`);
  return payload as T;
}

function currency(value: number, code: string): string {
  if (!Number.isFinite(value)) return '—';
  if (!/^[A-Z]{3}$/.test(code)) return `${value.toLocaleString()} ${code}`.trim();
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: code,
    maximumFractionDigits: 2,
  }).format(value);
}

function billingPeriodLabel(period: string, granularity: 'Daily' | 'Monthly'): string {
  const [year, month, day] = period.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day ?? 1));
  return new Intl.DateTimeFormat(undefined, {
    ...(granularity === 'Daily' ? { dateStyle: 'medium' as const } : { month: 'long' as const, year: 'numeric' as const }),
    timeZone: 'UTC',
  }).format(date);
}

function resourceNameFromId(resourceId: string): string {
  if (resourceId === 'Unassigned') return resourceId;
  const name = resourceId.split('/').filter(Boolean).pop();
  if (!name) return resourceId;
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

function resourceGroupFromId(resourceId: string): string {
  const match = resourceId.match(/(?:^|\/)resourceGroups\/([^/]+)/i);
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function DashboardShell() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [preferences, setPreferences] = useState<Preferences>({ subscriptionId: null });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [retrySeconds, setRetrySeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [costData, setCostData] = useState<CostData | null>(null);
  const costRequestInFlight = useRef(false);
  const autoLoadStarted = useRef(false);
  const [servicePage, setServicePage] = useState(0);

  useEffect(() => {
    if (retrySeconds <= 0) return undefined;
    const timer = window.setTimeout(() => {
      setRetrySeconds((seconds) => Math.max(0, seconds - 1));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [retrySeconds]);

  const loadCosts = useCallback(async (
    subscriptionId = preferences.subscriptionId,
    requestedStart = startOfCurrentMonth(),
    requestedEnd = dateOffset(0),
  ) => {
    if (!subscriptionId) {
      setError('Connect Azure and select a subscription first.');
      return;
    }
    const cacheKey = auth?.costCacheScope
      ? liveCostCacheKey(auth.costCacheScope, subscriptionId, requestedStart, requestedEnd)
      : null;
    const cachedData = cacheKey ? liveCostCache.get(cacheKey) : undefined;
    if (cachedData) {
      setCostData(cachedData);
      setServicePage(0);
      setError(null);
      return;
    }
    if (costRequestInFlight.current || retrySeconds > 0) return;
    costRequestInFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        subscription_id: subscriptionId,
        start_date: requestedStart,
        end_date: requestedEnd,
        granularity: 'Daily',
        compare: 'false',
      });
      const response = await fetch(`/api/costs?${params}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 429) {
          const retryAfter = Number(response.headers.get('Retry-After'));
          setRetrySeconds(Math.max(30, Number.isFinite(retryAfter) ? retryAfter : 0));
        }
        throw new Error(payload.detail ?? `Request failed (${response.status}).`);
      }
      const result = payload as CostData;
      setCostData(result);
      if (cacheKey) cacheLiveCosts(cacheKey, result);
      setServicePage(0);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not load Azure cost data.');
    } finally {
      costRequestInFlight.current = false;
      setBusy(false);
    }
  }, [auth?.costCacheScope, preferences.subscriptionId, retrySeconds]);

  useEffect(() => {
    async function initialize() {
      try {
        const status = await apiRequest<AuthStatus>('/api/auth/status');
        setAuth(status);
        if (status.connected) {
          setPreferences(await apiRequest<Preferences>('/api/preferences'));
        }
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : 'Could not load Azure connection.');
      } finally {
        setLoading(false);
      }
    }
    void initialize();
  }, []);

  useEffect(() => {
    if (!auth?.connected || !preferences.subscriptionId || autoLoadStarted.current) return;
    autoLoadStarted.current = true;
    void loadCosts(preferences.subscriptionId, startOfCurrentMonth(), dateOffset(0));
  }, [auth?.connected, loadCosts, preferences.subscriptionId]);

  const visibleServices = costData?.byService.slice(
    servicePage * SERVICES_PER_PAGE,
    (servicePage + 1) * SERVICES_PER_PAGE,
  ) ?? [];
  const servicePageCount = Math.ceil((costData?.byService.length ?? 0) / SERVICES_PER_PAGE);
  const topServices = [...(costData?.byService ?? [])]
    .sort((first, second) => second.cost - first.cost || first.name.localeCompare(second.name))
    .slice(0, 3);
  const totalServiceCost = (costData?.byService ?? []).reduce((sum, service) => sum + service.cost, 0);

  function exportLiveCostCsv() {
    if (!costData) return;
    const rows = [['UsageDate', 'ResourceGroup', 'ServiceName', 'Cost', 'Currency']];
    for (const day of costData.trend) {
      const resourceServices = costData.serviceResourceTrend?.find((item) => item.period === day.period)?.services ?? [];
      if (resourceServices.length) {
        for (const service of resourceServices) {
          if (service.resources.length) {
            for (const resource of service.resources) {
              rows.push([
                day.period,
                resourceGroupFromId(resource.resourceId),
                service.name,
                String(resource.cost),
                costData.currency,
              ]);
            }
          } else {
            const serviceCost = costData.serviceTrend
              ?.find((item) => item.period === day.period)
              ?.services.find((item) => item.name === service.name)?.cost;
            if (serviceCost !== undefined) {
              rows.push([day.period, '', service.name, String(serviceCost), costData.currency]);
            }
          }
        }
        continue;
      }

      const services = costData.serviceTrend?.find((item) => item.period === day.period)?.services ?? [];
      if (services.length) {
        for (const service of services) {
          rows.push([day.period, '', service.name, String(service.cost), costData.currency]);
        }
      } else {
        rows.push([day.period, '', '', String(day.cost), costData.currency]);
      }
    }

    const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `azure-cost-details-${costData.range.from}-to-${costData.range.to}.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (loading) return <main className="flex min-h-screen items-center justify-center p-6"><AzureConnectionLoader /></main>;

  if (!auth?.connected) {
    return (
      <main className="landing-page relative isolate flex min-h-screen items-start overflow-hidden px-4 py-6 sm:px-8 lg:px-[3.25rem]">
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-48 w-full sm:h-64"
          viewBox="0 0 1600 300"
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id="landing-wave" x1="0" x2="1" y1="0" y2="0">
              <stop offset="0%" stopColor="#0878d1" stopOpacity=".08" />
              <stop offset="55%" stopColor="#0878d1" stopOpacity=".02" />
              <stop offset="100%" stopColor="#28b8ff" stopOpacity=".2" />
            </linearGradient>
          </defs>
          <path d="M0 180 C240 35 360 125 570 200 S900 180 1100 110 S1400 200 1600 55 V300 H0Z" fill="url(#landing-wave)" />
          <path d="M0 180 C240 35 360 125 570 200 S900 180 1100 110 S1400 200 1600 55" fill="none" stroke="#0878d1" strokeOpacity=".42" strokeWidth="2" />
          <path d="M0 235 C250 90 430 285 700 245 S1120 75 1320 135 S1510 140 1600 105" fill="none" stroke="#168fe5" strokeOpacity=".22" strokeWidth="2" />
        </svg>
        <div className="mx-auto w-full max-w-[1520px]">
          <div className="relative mb-9 h-[68px] w-[340px] max-w-full overflow-hidden sm:mb-10">
            <Image
              src="/cloud-grid-logo.png"
              alt="Cloud Grid"
              width={2172}
              height={724}
              priority
              className="absolute left-1/2 top-1/2 h-auto w-[133%] max-w-none -translate-x-1/2 -translate-y-1/2 mix-blend-lighten"
            />
          </div>
          <section className="grid gap-8 rounded-[32px] border border-sky-500/30 bg-slate-950/65 p-6 shadow-[0_24px_100px_rgba(0,0,0,0.42)] backdrop-blur-md sm:p-10 md:grid-cols-[minmax(0,2fr)_minmax(320px,0.95fr)] md:items-center md:gap-10 md:px-12 md:py-10 lg:gap-12 lg:px-[4.25rem] lg:py-14">
            <div className="md:pr-2">
              <p className="text-xs font-bold uppercase tracking-[0.24em] text-cyan-300 sm:text-sm">
                Azure cost management
              </p>
              <h1 className="mt-3 text-4xl font-bold leading-tight tracking-tight text-white sm:text-5xl lg:text-[4.1rem]">
                Azure Cost <span className="bg-gradient-to-r from-sky-400 to-cyan-300 bg-clip-text text-transparent">Dashboard</span>
              </h1>
              <p className="mt-4 max-w-3xl text-base leading-7 text-slate-300 sm:text-lg">
                Monitor subscription costs, analyze resource usage, and explore your Azure environment in one place.
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <span className="inline-flex items-center gap-2.5 rounded-full border border-sky-300/25 bg-slate-900/45 px-4 py-3 text-sm font-medium text-slate-100 sm:px-5">
                  <BarChart3 size={20} className="text-sky-400" aria-hidden="true" />
                  Cost Overview
                </span>
                <span className="inline-flex items-center gap-2.5 rounded-full border border-sky-300/25 bg-slate-900/45 px-4 py-3 text-sm font-medium text-slate-100 sm:px-5">
                  <Layers size={20} className="text-sky-400" aria-hidden="true" />
                  Resource Inventory
                </span>
                <span className="inline-flex items-center gap-2.5 rounded-full border border-sky-300/25 bg-slate-900/45 px-4 py-3 text-sm font-medium text-slate-100 sm:px-5">
                  <ArrowLeftRight size={20} className="text-sky-400" aria-hidden="true" />
                  Period Comparison
                </span>
              </div>
            </div>
            <div className="border-t border-sky-300/20 pt-7 md:border-l md:border-t-0 md:py-3 md:pl-10 md:pt-3 lg:pl-12">
              <div className="rounded-[28px] border border-sky-400/25 bg-gradient-to-br from-blue-900/60 via-slate-900/90 to-slate-950/90 p-6 shadow-[0_18px_50px_rgba(0,75,180,0.2)] sm:p-8">
                <h2 className="text-xl font-semibold text-white sm:text-2xl">Connect an Azure account</h2>
                <p className="mt-3 text-sm leading-6 text-slate-300 sm:text-base">
                  Sign in to view your costs and resources.
              </p>
                {!auth?.configured && (
                  <p className="mt-3 text-sm text-amber-200">
                    Azure sign-in needs backend app-registration configuration before it can be used.
                  </p>
                )}
                <Link
                  href="/connect-azure"
                  className="mt-6 inline-flex min-h-14 w-full items-center justify-between gap-4 rounded-full bg-gradient-to-r from-sky-500 to-blue-600 px-5 text-base font-semibold text-white shadow-lg shadow-blue-950/40 transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 sm:px-6"
                >
                  <span className="flex items-center gap-3">
                    <span aria-hidden="true" className="grid grid-cols-2 gap-0.5 rounded-sm bg-white p-1 shadow-sm">
                      <span className="h-3 w-3 bg-[#f25022]" />
                      <span className="h-3 w-3 bg-[#7fba00]" />
                      <span className="h-3 w-3 bg-[#00a4ef]" />
                      <span className="h-3 w-3 bg-[#ffb900]" />
                    </span>
                    Connect Azure
                  </span>
                  <ArrowRight size={22} aria-hidden="true" />
                </Link>
              </div>
            </div>
          </section>
          {error && <p role="alert" className="mt-4 text-sm text-red-300">{error}</p>}
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen p-6">
      <div className="mx-auto max-w-[1520px] space-y-6">
        <header className="flex flex-col gap-4 rounded-2xl border border-sky-400/20 bg-slate-950/75 p-4 shadow-soft sm:flex-row sm:items-center sm:justify-between">
          <Link href="/" className="relative block h-12 w-[270px] max-w-full overflow-hidden sm:h-14 sm:w-[320px]" aria-label="Cloud Grid dashboard">
            <Image
              src="/cloud-grid-logo.png"
              alt="Cloud Grid"
              width={2172}
              height={724}
              priority
              className="absolute left-1/2 top-1/2 h-auto w-[133%] max-w-none -translate-x-1/2 -translate-y-1/2 mix-blend-lighten"
            />
          </Link>
          <nav aria-label="Main navigation" className="flex flex-wrap items-center gap-2">
            <Link href="/compare" className="secondary-button gap-2 rounded-xl border border-sky-600/90 bg-sky-950/60 px-4 py-2 shadow-[0_0_16px_rgba(14,165,233,0.1)]">
              <BarChart3 size={21} className="text-cyan-300" aria-hidden="true" />
              Compare Costs
            </Link>
            <Link href="/resources" className="secondary-button gap-2 rounded-xl border border-sky-600/90 bg-sky-950/60 px-4 py-2 shadow-[0_0_16px_rgba(14,165,233,0.1)]">
              <Boxes size={21} className="text-cyan-300" aria-hidden="true" />
              Resource Inventory
            </Link>
            <Link href="/connect-azure" className="secondary-button gap-2 rounded-xl border border-sky-600/90 bg-sky-950/60 px-4 py-2 shadow-[0_0_16px_rgba(14,165,233,0.1)]">
              <Settings size={21} className="text-cyan-300" aria-hidden="true" />
              Connection Settings
            </Link>
            <DisconnectButton />
          </nav>
        </header>

        <section className="relative overflow-hidden rounded-2xl border-2 border-cyan-500 bg-[radial-gradient(ellipse_at_78%_100%,rgba(0,148,255,0.2),transparent_38%),linear-gradient(110deg,rgba(3,38,70,0.98),rgba(4,26,54,0.97)_58%,rgba(2,17,37,0.98))] px-5 py-5 shadow-[0_12px_36px_rgba(0,140,255,0.1)] sm:px-7 sm:py-6">
          <div className="relative z-10">
            <p className="text-sm font-bold uppercase tracking-wide text-cyan-300 sm:text-base">Subscription-wide Azure costs</p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight text-white sm:text-4xl">Billing management</h1>
            <p className="mt-1.5 text-sm text-slate-100 sm:text-base">
              Subscription: {preferences.subscriptionId ?? 'No subscription selected'}
            </p>
          </div>
          <svg aria-hidden="true" className="pointer-events-none absolute bottom-0 right-0 h-20 w-[55%] sm:h-24" viewBox="0 0 720 130" fill="none" preserveAspectRatio="none">
            <defs>
              <linearGradient id="billing-header-wave-fill" x1="0" y1="0" x2="720" y2="130" gradientUnits="userSpaceOnUse">
                <stop stopColor="#0787e8" stopOpacity=".04" />
                <stop offset="1" stopColor="#0787e8" stopOpacity=".34" />
              </linearGradient>
            </defs>
            <path d="M0 129C105 108 175 43 275 45c112 2 156 78 260 65 74-9 111-51 185-84v104H0Z" fill="url(#billing-header-wave-fill)" />
            <path d="M0 129C105 108 175 43 275 45c112 2 156 78 260 65 74-9 111-51 185-84" stroke="#08bdf5" strokeOpacity=".65" strokeWidth="2" />
          </svg>
        </section>

        {error && <div role="alert" className="rounded-xl border border-red-800 bg-red-950/60 p-4 text-red-200">{error}</div>}

        {!preferences.subscriptionId ? (
          <section className="dashboard-card">
            <h2 className="text-xl font-semibold text-white">Choose a subscription</h2>
            <p className="mt-2 text-sm text-slate-300">Select a subscription to load its costs.</p>
            <Link href="/connect-azure" className="primary-button mt-4">Set up Azure connection</Link>
          </section>
        ) : (
          <>
            {costData ? (
              <>
                <section>
                  <article className="relative flex flex-wrap items-center justify-between gap-4 overflow-hidden rounded-xl border-2 border-sky-500 bg-[linear-gradient(105deg,rgba(6,29,55,0.98),rgba(3,22,44,0.98))] px-4 py-3.5 shadow-[0_10px_32px_rgba(0,140,255,0.08)] sm:px-5">
                    <div className="relative z-10 flex items-stretch gap-3 sm:gap-4">
                      <span aria-hidden="true" className="w-1 shrink-0 rounded-full bg-gradient-to-b from-cyan-400 via-sky-500 to-sky-900" />
                      <div>
                        <p className="text-base font-bold text-white sm:text-lg">Live Cost This Month</p>
                        <p className="mt-0.5 text-xs text-slate-300 sm:text-sm">{costData.range.from} to {costData.range.to}</p>
                        <p className="mt-1 text-2xl font-bold leading-tight tracking-tight text-white sm:text-3xl">
                          {currency(costData.total, costData.currency)}
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="relative z-10 inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-cyan-400 bg-slate-950/30 px-4 py-2 text-sm font-semibold text-white transition hover:bg-cyan-500/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 disabled:cursor-not-allowed disabled:opacity-50 sm:ml-auto"
                      disabled={!costData.trend.length}
                      onClick={exportLiveCostCsv}
                    >
                      <Download size={21} className="text-cyan-300" aria-hidden="true" />
                      Export Details
                    </button>
                  </article>
                </section>

                <section className="rounded-xl border border-sky-500/40 bg-slate-900/70 p-4">
                  <div className="mb-3 flex items-center gap-3">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-2 border-cyan-500/80 bg-cyan-500/10 text-cyan-300 shadow-[0_0_14px_rgba(6,182,212,0.12)]">
                      <Layers size={25} aria-hidden="true" />
                    </span>
                    <div>
                      <h2 className="text-lg font-semibold text-white">Top 3 Azure Services by Cost</h2>
                      <p className="mt-0.5 text-xs text-slate-400">
                      Highest spend this month ({costData.range.from} – {costData.range.to})
                      </p>
                    </div>
                  </div>
                  {topServices.length === 0 ? (
                    <p className="text-sm text-slate-400">No service costs were returned for this month.</p>
                  ) : (
                    <ol className="grid gap-3 md:grid-cols-3">
                      {topServices.map((service, index) => {
                      const ServiceIcon = /database|sql/i.test(service.name)
                        ? Database
                        : /virtual machine|compute/i.test(service.name)
                          ? Server
                          : /redis|cache/i.test(service.name)
                            ? Layers
                            : Boxes;
                      const share = totalServiceCost > 0 ? (service.cost / totalServiceCost) * 100 : 0;
                      const cardStyle = index === 0
                        ? 'border-cyan-400 bg-cyan-500/5'
                        : index === 1
                          ? 'border-violet-400/70 bg-violet-500/5'
                          : 'border-slate-600 bg-slate-950/40';
                      const iconStyle = index === 0
                        ? 'border-cyan-400/80 bg-cyan-500/10 text-cyan-300'
                        : index === 1
                          ? 'border-violet-400/80 bg-violet-500/10 text-violet-300'
                          : 'border-sky-600/80 bg-sky-500/10 text-sky-200';
                      const rankStyle = index === 0
                        ? 'bg-amber-400 text-amber-950'
                        : index === 1
                          ? 'bg-slate-300 text-slate-900'
                          : 'bg-orange-400 text-orange-950';
                      return (
                      <li
                        key={service.name}
                        className={`flex min-w-0 items-center gap-3 rounded-xl border p-3 ${cardStyle}`}
                      >
                        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-bold ${rankStyle}`}>
                          {index + 1}
                        </span>
                        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border-2 ${iconStyle}`}>
                          <ServiceIcon size={23} aria-hidden="true" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="break-words text-sm font-medium leading-5 text-white" title={service.name}>
                            {service.name}
                          </p>
                          <div className="mt-2 flex items-center justify-between gap-2">
                            <p className="whitespace-nowrap font-semibold text-white">{currency(service.cost, costData.currency)}</p>
                            <span className="whitespace-nowrap rounded-lg bg-sky-500/25 px-2 py-1 text-[10px] font-semibold text-sky-100">
                              {share.toFixed(1)}%
                            </span>
                          </div>
                        </div>
                      </li>
                      );
                      })}
                    </ol>
                  )}
                </section>

                <section className="grid gap-4 xl:grid-cols-2">
                  <div className="dashboard-card">
                    <div className="mb-3 flex items-center gap-3">
                      <div className="flex items-center gap-3">
                        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border-2 border-cyan-500/80 bg-cyan-500/10 text-cyan-300 shadow-[0_0_14px_rgba(6,182,212,0.12)]">
                          <CalendarDays size={25} aria-hidden="true" />
                        </span>
                        <div>
                          <h2 className="text-lg font-semibold text-white">Bill by Date</h2>
                          <p className="mt-0.5 text-xs text-slate-400">
                            Daily totals with billed services and resources ({costData.range.from} – {costData.range.to})
                          </p>
                        </div>
                      </div>
                    </div>
                    <div className="max-h-[360px] overflow-y-auto rounded-xl border border-slate-700">
                      {costData.trend.length === 0 ? (
                        <p className="p-4 text-sm text-slate-400">No billing details were returned for this period.</p>
                      ) : (
                        <div className="min-w-[480px]">
                          <div className="sticky top-0 z-10 grid grid-cols-[1.1fr_1fr_0.7fr_0.7fr] gap-2 bg-sky-950/90 px-3 py-2.5 text-[11px] font-medium text-slate-300 sm:px-4">
                            <span>Date</span>
                            <span className="text-right">Daily Total</span>
                            <span className="text-right">Change</span>
                            <span className="text-right">Services</span>
                          </div>
                          <div className="px-2 sm:px-3">
                            {costData.trend.map((item, index) => {
                              const services = costData.serviceTrend?.find((trend) => trend.period === item.period)?.services ?? [];
                              const servicesWithResources = costData.serviceResourceTrend?.find(
                                (trend) => trend.period === item.period,
                              )?.services ?? [];
                              const previousCost = costData.trend[index - 1]?.cost;
                              const changePercent = previousCost && previousCost !== 0
                                ? ((item.cost - previousCost) / previousCost) * 100
                                : null;
                              return (
                                <details
                                  key={item.period}
                                  open={index === 0}
                                  className="group border-b border-slate-800 last:border-b-0"
                                >
                                  <summary className="grid cursor-pointer list-none grid-cols-[1.1fr_1fr_0.7fr_0.7fr] items-center gap-2 py-2.5 text-xs text-slate-200 marker:content-none hover:text-white">
                                    <span className="flex min-w-0 items-center gap-2 font-medium">
                                      <span className="text-slate-400 transition-transform group-open:rotate-90">›</span>
                                      <span className="truncate">{billingPeriodLabel(item.period, 'Daily')}</span>
                                    </span>
                                    <span className="whitespace-nowrap text-right font-medium">
                                      {currency(item.cost, costData.currency)}
                                    </span>
                                    <span className={`whitespace-nowrap text-right text-[11px] font-medium ${
                                      changePercent === null
                                        ? 'text-slate-500'
                                        : changePercent > 0
                                          ? 'text-rose-400'
                                          : changePercent < 0
                                            ? 'text-emerald-400'
                                            : 'text-slate-400'
                                    }`}>
                                      {changePercent === null
                                        ? '—'
                                        : `${changePercent > 0 ? '↑ +' : changePercent < 0 ? '↓ ' : ''}${changePercent.toFixed(1)}%`}
                                    </span>
                                    <span className="justify-self-end whitespace-nowrap rounded-full border border-slate-700 bg-slate-800/80 px-2 py-1 text-[10px] text-slate-300">
                                      {services.length} {services.length === 1 ? 'service' : 'services'}
                                    </span>
                                  </summary>
                                  <div className="mb-3 ml-2 rounded-lg border border-slate-800 bg-slate-900/65 p-3 sm:ml-5">
                                    {services.length === 0 ? (
                                      <p className="text-xs text-slate-400">No service breakdown for this date.</p>
                                    ) : (
                                      <>
                                        <div className="mb-2 grid grid-cols-[minmax(0,1fr)_auto_auto] gap-3 border-b border-slate-700/80 pb-2 text-[10px] uppercase tracking-wide text-slate-400">
                                          <span>Service</span>
                                          <span className="text-right">Cost</span>
                                          <span className="w-16 text-right">Share</span>
                                        </div>
                                        <div className="space-y-1">
                                          {services.map((service) => {
                                            const share = item.cost > 0 ? (service.cost / item.cost) * 100 : 0;
                                            const serviceResources = servicesWithResources.find(
                                              (entry) => entry.name === service.name,
                                            )?.resources ?? [];
                                            return (
                                              <details
                                                key={`${item.period}-${service.name}`}
                                                className="group/service rounded-md"
                                              >
                                                <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 rounded-md py-1.5 text-xs marker:content-none hover:bg-slate-800/60">
                                                  <span className="flex min-w-0 items-center gap-2 text-slate-200">
                                                    <span className="text-slate-400 transition-transform group-open/service:rotate-90">›</span>
                                                    <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-sm bg-cyan-400" />
                                                    <span className="truncate" title={service.name}>{service.name}</span>
                                                  </span>
                                                  <span className="whitespace-nowrap text-right text-slate-200">
                                                    {currency(service.cost, costData.currency)}
                                                  </span>
                                                  <span className="w-16 text-right text-[10px] text-slate-400">
                                                    {share.toFixed(1)}%
                                                  </span>
                                                </summary>
                                                <div className="mb-1 ml-5 rounded-md border border-slate-800 bg-slate-950/60 p-2">
                                                  {serviceResources.length === 0 ? (
                                                    <p className="text-[11px] text-slate-400">
                                                      No resource-level costs were returned for this service.
                                                    </p>
                                                  ) : (
                                                    <div className="space-y-1.5">
                                                      {serviceResources.map((resource) => (
                                                        <div
                                                          key={`${item.period}-${service.name}-${resource.resourceId}`}
                                                          className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 text-[11px]"
                                                        >
                                                          <span
                                                            className="truncate text-slate-300"
                                                            title={resource.resourceId}
                                                          >
                                                            {resourceNameFromId(resource.resourceId)}
                                                          </span>
                                                          <span className="whitespace-nowrap text-right text-slate-200">
                                                            {currency(resource.cost, costData.currency)}
                                                          </span>
                                                        </div>
                                                      ))}
                                                    </div>
                                                  )}
                                                </div>
                                              </details>
                                            );
                                          })}
                                        </div>
                                      </>
                                    )}
                                  </div>
                                </details>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="relative isolate overflow-hidden rounded-2xl border-2 border-sky-500 bg-[radial-gradient(ellipse_at_80%_100%,rgba(0,148,255,0.12),transparent_38%),linear-gradient(145deg,rgba(3,30,54,0.98),rgba(2,15,34,0.98))] p-4 shadow-[0_16px_50px_rgba(0,140,255,0.08)] sm:p-5">
                    <svg aria-hidden="true" className="pointer-events-none absolute bottom-0 right-0 -z-10 h-24 w-full text-sky-500/15" viewBox="0 0 1200 100" fill="none" preserveAspectRatio="none">
                      <path d="M0 86C145 70 180 38 310 50s170 57 310 44 185-66 315-70 170 42 265 25v51H0z" fill="currentColor" />
                      <path d="M0 86C145 70 180 38 310 50s170 57 310 44 185-66 315-70 170 42 265 25" stroke="#06b6d4" strokeOpacity=".5" strokeWidth="2" />
                    </svg>
                    <div className="relative z-10 mb-4 flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border-2 border-cyan-500/80 bg-cyan-500/10 text-cyan-300 shadow-[0_0_16px_rgba(6,182,212,0.14)]">
                          <BarChart3 size={28} aria-hidden="true" />
                        </span>
                        <div>
                          <h2 className="text-xl font-semibold text-white">Spend by Azure Service</h2>
                          <p className="mt-0.5 text-sm text-slate-300">Total spend by service ({costData.currency})</p>
                        </div>
                      </div>
                      {servicePageCount > 1 && (
                          <div className="flex items-center gap-2">
                          <button
                            type="button"
                            className="secondary-button border border-sky-600/80 bg-sky-950/50 p-2 text-cyan-300"
                            aria-label="Previous services"
                            disabled={servicePage === 0}
                            onClick={() => setServicePage((page) => Math.max(0, page - 1))}
                          >
                            <ChevronLeft size={21} />
                          </button>
                          <span className="text-xs text-slate-400">
                            {servicePage + 1} / {servicePageCount}
                          </span>
                          <button
                            type="button"
                            className="secondary-button border border-sky-600/80 bg-sky-950/50 p-2 text-cyan-300"
                            aria-label="Next services"
                            disabled={servicePage >= servicePageCount - 1}
                            onClick={() => setServicePage((page) => Math.min(servicePageCount - 1, page + 1))}
                          >
                            <ChevronRight size={21} />
                          </button>
                          </div>
                      )}
                    </div>
                    <div className="relative z-10 h-[360px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={visibleServices} layout="vertical" margin={{ left: 4, right: 110 }} barCategoryGap="15%">
                          <defs>
                            <linearGradient id="service-spend-gradient" x1="0" y1="0" x2="1" y2="0">
                              <stop offset="0%" stopColor="#06d6e8" />
                              <stop offset="100%" stopColor="#0787ff" />
                            </linearGradient>
                          </defs>
                          <CartesianGrid stroke="#164e63" strokeDasharray="4 4" horizontal={false} />
                          <XAxis type="number" stroke="#cbd5e1" tick={{ fontSize: 11 }} />
                          <YAxis dataKey="name" type="category" width={120} stroke="#cbd5e1" tick={{ fontSize: 11 }} />
                          <Bar
                            dataKey="cost"
                            fill="url(#service-spend-gradient)"
                            radius={[0, 7, 7, 0]}
                            barSize={28}
                            isAnimationActive={false}
                            activeBar={false}
                          >
                            <LabelList
                              dataKey="cost"
                              position="right"
                              formatter={(value: number, index: number) => {
                                const share = totalServiceCost > 0 ? (value / totalServiceCost) * 100 : 0;
                                return `${currency(value, costData.currency)} (${share.toFixed(1)}%)`;
                              }}
                              fill="#f8fafc"
                              fontSize={10}
                              fontWeight={600}
                            />
                          </Bar>
                       </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </section>

              </>
            ) : busy ? (
              <section
                role="status"
                aria-live="polite"
                aria-busy="true"
                className="dashboard-card overflow-hidden border-sky-500/50"
              >
                <div className="flex items-center gap-3">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-cyan-400/30 bg-cyan-500/10 text-cyan-300">
                    <Loader2 size={24} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  </span>
                  <div>
                    <h2 className="text-lg font-semibold text-white">Loading cost details</h2>
                    <p className="mt-1 text-sm text-slate-300">
                      Fetching this month&apos;s billing data from Azure. This may take a little while.
                    </p>
                  </div>
                </div>
                <div aria-hidden="true" className="mt-5 grid gap-4 sm:grid-cols-3">
                  <div className="h-20 animate-pulse rounded-xl border border-sky-500/20 bg-sky-500/10" />
                  <div className="h-20 animate-pulse rounded-xl border border-sky-500/20 bg-sky-500/10 [animation-delay:150ms]" />
                  <div className="h-20 animate-pulse rounded-xl border border-sky-500/20 bg-sky-500/10 [animation-delay:300ms]" />
                </div>
                <div aria-hidden="true" className="mt-4 h-2 overflow-hidden rounded-full bg-slate-800">
                  <div className="h-full w-1/3 animate-pulse rounded-full bg-gradient-to-r from-cyan-400 via-sky-500 to-blue-500" />
                </div>
              </section>
            ) : null}
          </>
        )}
      </div>
    </main>
  );
}
