'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowDown, ArrowLeft, ArrowLeftRight, Boxes, CalendarDays, Database, Download, Home, Info, Layers, Server, TrendingUp } from 'lucide-react';
import {
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { DisconnectButton } from '@/components/disconnect-button';
import { AzureConnectionLoader } from '@/components/azure-connection-loader';
import { fetchWithTimeout } from '@/lib/api';

type AuthStatus = { configured: boolean; connected: boolean; tenantId: string | null };
type Preferences = { subscriptionId: string | null };
type BillingDisplay = 'Daily' | 'Cumulative';
type CostData = {
  total: number;
  previousTotal: number | null;
  currency: string;
  granularity: BillingDisplay;
  trend: { period: string; cost: number }[];
  previousTrend?: { period: string; cost: number }[];
  serviceTrend?: { period: string; services: { name: string; cost: number }[] }[];
  previousServiceTrend?: { period: string; services: { name: string; cost: number }[] }[];
  serviceResourceTrend?: {
    period: string;
    services: { name: string; resources: { resourceId: string; cost: number }[] }[];
  }[];
  previousServiceResourceTrend?: {
    period: string;
    services: { name: string; resources: { resourceId: string; cost: number }[] }[];
  }[];
  resourceTrend?: { period: string; resources: { resourceId: string; cost: number }[] }[];
  previousResourceTrend?: { period: string; resources: { resourceId: string; cost: number }[] }[];
  change: number | null;
  changePercent: number | null;
  range: { from: string; to: string };
  previousRange: { from: string; to: string } | null;
  comparisonEnabled: boolean;
  serviceComparison: { name: string; current: number; previous: number; change: number }[];
  resourceComparison: { resourceId: string; current: number; previous: number; change: number }[];
};
type BillingService = { name: string; cost: number };
type AvailableService = { name: string; cost: number };
type BillingResource = { resourceId: string; cost: number };
type BillingServiceResources = { name: string; resources: BillingResource[] };

function filterBillingServices(
  services: BillingService[],
  servicesWithResources: BillingServiceResources[],
  selectedService: string,
  selectedResourceId: string,
) {
  const filtered = services.flatMap((service) => {
    if (selectedService !== 'all' && service.name !== selectedService) return [];
    const serviceResources = servicesWithResources.find((entry) => entry.name === service.name)?.resources ?? [];
    const resources = selectedResourceId === 'all'
      ? serviceResources
      : serviceResources.filter((resource) =>
        resource.resourceId.toLowerCase() === selectedResourceId.toLowerCase(),
      );
    if (selectedResourceId !== 'all' && resources.length === 0) return [];
    return [{
      ...service,
      cost: selectedResourceId === 'all'
        ? service.cost
        : resources.reduce((sum, resource) => sum + resource.cost, 0),
      resources,
    }];
  });
  return {
    services: filtered,
    total: filtered.reduce((sum, service) => sum + service.cost, 0),
  };
}

function filteredPeriodTotal(
  total: number,
  servicesByPeriod: NonNullable<CostData['serviceTrend']>,
  resourcesByServiceAndPeriod: NonNullable<CostData['serviceResourceTrend']>,
  selectedService: string,
  selectedResourceId: string,
): number {
  if (selectedService === 'all' && selectedResourceId === 'all') return total;
  return servicesByPeriod.reduce((rangeTotal, period) => {
    const services = period.services.filter((service) =>
      selectedService === 'all' || service.name === selectedService,
    );
    if (selectedResourceId === 'all') {
      return rangeTotal + services.reduce((sum, service) => sum + service.cost, 0);
    }
    const periodResources = resourcesByServiceAndPeriod.find((item) => item.period === period.period)?.services ?? [];
    return rangeTotal + services.reduce((sum, service) => {
      const resource = periodResources
        .find((entry) => entry.name === service.name)?.resources
        .find((entry) =>
          entry.resourceId.toLowerCase() === selectedResourceId.toLowerCase(),
        );
      return sum + (resource?.cost ?? 0);
    }, 0);
  }, 0);
}

function dateOffset(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function startOfCurrentMonth(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`;
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

function resourceTypeFromId(resourceId: string): string {
  const parts = resourceId.split('/').filter(Boolean);
  const providerIndex = parts.findIndex((part) => part.toLowerCase() === 'providers');
  if (providerIndex < 0 || !parts[providerIndex + 1]) return '';

  const typeSegments: string[] = [];
  for (let index = providerIndex + 2; index < parts.length; index += 2) {
    typeSegments.push(parts[index]);
  }
  return typeSegments.length ? `${parts[providerIndex + 1]}/${typeSegments.join('/')}` : '';
}

function billingPeriodLabel(period: string): string {
  const [year, month, day] = period.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day ?? 1));
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeZone: 'UTC',
  }).format(date);
}

function billingPeriodsInRange(from: string, to: string): string[] {
  const [fromYear, fromMonth, fromDay] = from.split('-').map(Number);
  const [toYear, toMonth, toDay] = to.split('-').map(Number);
  const current = new Date(Date.UTC(
    fromYear,
    fromMonth - 1,
    fromDay,
  ));
  const end = new Date(Date.UTC(
    toYear,
    toMonth - 1,
    toDay,
  ));
  const periods: string[] = [];

  while (current <= end) {
    periods.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return periods;
}

function billingRangeHeader(from: string, to: string): string {
  const monthLabel = (period: string) => {
    const [year, month] = period.split('-').map(Number);
    return new Intl.DateTimeFormat(undefined, { month: 'long', timeZone: 'UTC' })
      .format(new Date(Date.UTC(year, month - 1, 1)));
  };
  const startMonth = monthLabel(from);
  const endMonth = monthLabel(to);
  return startMonth === endMonth ? startMonth : `${startMonth}–${endMonth}`;
}

function csvPeriodDate(period: string): string {
  const [year, month, day] = period.split('-');
  return `${day}-${month}-${year.slice(-2)}`;
}

export default function CompareCostsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [subscriptionId, setSubscriptionId] = useState<string | null>(null);
  const [startDate, setStartDate] = useState(startOfCurrentMonth());
  const [endDate, setEndDate] = useState(dateOffset(0));
  const [comparisonStartDate, setComparisonStartDate] = useState('');
  const [comparisonEndDate, setComparisonEndDate] = useState('');
  const [granularity, setGranularity] = useState<BillingDisplay>('Cumulative');
  const [costData, setCostData] = useState<CostData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedService, setSelectedService] = useState('all');
  const [selectedResourceId, setSelectedResourceId] = useState('all');
  const [availableServices, setAvailableServices] = useState<{
    key: string;
    services: AvailableService[];
  } | null>(null);
  const [loadingServices, setLoadingServices] = useState(false);
  const comparisonRequestInProgress = useRef(false);
  const serviceLookupInProgress = useRef(false);

  useEffect(() => {
    async function initialize() {
      try {
        const statusResponse = await fetchWithTimeout('/api/auth/status');
        const status = await statusResponse.json();
        if (!statusResponse.ok) throw new Error(status.detail ?? 'Could not check the Azure connection.');
        setAuth(status as AuthStatus);
        if (status.connected) {
          const preferencesResponse = await fetchWithTimeout('/api/preferences');
          const preferences = await preferencesResponse.json();
          if (!preferencesResponse.ok) throw new Error(preferences.detail ?? 'Could not load subscription settings.');
          setSubscriptionId((preferences as Preferences).subscriptionId);
        }
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : 'Could not load Azure connection.');
      } finally {
        setLoading(false);
      }
    }
    void initialize();
  }, []);

  const rangesAreValid = Boolean(
    startDate &&
    endDate &&
    comparisonStartDate &&
    comparisonEndDate &&
    startDate <= endDate &&
    comparisonStartDate <= comparisonEndDate &&
    endDate <= dateOffset(0) &&
    comparisonEndDate <= dateOffset(0) &&
    (endDate < comparisonStartDate || comparisonEndDate < startDate),
  );
  const rangesOverlap = Boolean(
    startDate &&
    endDate &&
    comparisonStartDate &&
    comparisonEndDate &&
    !(endDate < comparisonStartDate || comparisonEndDate < startDate),
  );
  const costPeriodIsRecent = !costData?.previousRange ||
    costData.range.to >= costData.previousRange.to;
  const comparisonDatesMatch = Boolean(
    costData &&
    costData.range.from === startDate &&
    costData.range.to === endDate &&
    costData.previousRange?.from === comparisonStartDate &&
    costData.previousRange?.to === comparisonEndDate,
  );
  const comparisonNeedsRefresh = Boolean(
    costData && (
      !comparisonDatesMatch ||
      costData.granularity !== granularity
    ),
  );
  const recentRange = costPeriodIsRecent ? costData?.range : costData?.previousRange;
  const earlierRange = costPeriodIsRecent ? costData?.previousRange : costData?.range;
  const costPeriodTotal = costData
    ? filteredPeriodTotal(
      costData.total,
      costData.serviceTrend ?? [],
      costData.serviceResourceTrend ?? [],
      selectedService,
      selectedResourceId,
    )
    : 0;
  const comparisonPeriodTotal = costData
    ? filteredPeriodTotal(
      costData.previousTotal ?? 0,
      costData.previousServiceTrend ?? [],
      costData.previousServiceResourceTrend ?? [],
      selectedService,
      selectedResourceId,
    )
    : 0;
  const recentTotal = costPeriodIsRecent ? costPeriodTotal : comparisonPeriodTotal;
  const earlierTotal = costPeriodIsRecent ? comparisonPeriodTotal : costPeriodTotal;
  const recentTotalChange = recentTotal - earlierTotal;
  const recentTotalChangePercent = earlierTotal ? (recentTotalChange / earlierTotal) * 100 : null;
  const serviceComparisonByRecency = (costData?.serviceComparison ?? []).map((service) => {
    const recent = costPeriodIsRecent ? service.current : service.previous;
    const earlier = costPeriodIsRecent ? service.previous : service.current;
    return { ...service, recent, earlier, change: recent - earlier };
  });
  const comparisonServiceOptions = serviceComparisonByRecency
    .slice()
    .sort((first, second) => second.recent + second.earlier - first.recent - first.earlier
      || first.name.localeCompare(second.name));
  const serviceLookupKey = JSON.stringify([
    subscriptionId,
    startDate,
    endDate,
    comparisonStartDate,
    comparisonEndDate,
  ]);
  const serviceOptions = availableServices?.key === serviceLookupKey
    ? availableServices.services
    : comparisonDatesMatch
      ? comparisonServiceOptions
      : [];
  const topServices = serviceComparisonByRecency
    .slice()
    .sort((first, second) => second.recent - first.recent || first.name.localeCompare(second.name))
    .slice(0, 3);
  const comparisonTopServices = serviceComparisonByRecency
    .slice()
    .sort((first, second) => second.earlier - first.earlier || first.name.localeCompare(second.name))
    .slice(0, 3);
  const aggregateResourceCosts = (
    trends: CostData['serviceResourceTrend'],
    serviceName: string,
  ) => {
    const costs = new Map<string, { resourceId: string; cost: number }>();
    for (const trend of trends ?? []) {
      const services = serviceName === 'all'
        ? trend.services
        : trend.services.filter((service) => service.name === serviceName);
      for (const service of services) {
        for (const resource of service.resources) {
          const key = resource.resourceId.toLowerCase();
          const current = costs.get(key);
          costs.set(key, {
            resourceId: current?.resourceId ?? resource.resourceId,
            cost: (current?.cost ?? 0) + resource.cost,
          });
        }
      }
    }
    return costs;
  };
  const costPeriodResourceCosts = aggregateResourceCosts(
    costData?.serviceResourceTrend,
    selectedService,
  );
  const comparisonPeriodResourceCosts = aggregateResourceCosts(
    costData?.previousServiceResourceTrend,
    selectedService,
  );
  const recentPeriodResourceCosts = costPeriodIsRecent ? costPeriodResourceCosts : comparisonPeriodResourceCosts;
  const earlierPeriodResourceCosts = costPeriodIsRecent ? comparisonPeriodResourceCosts : costPeriodResourceCosts;
  const resourceKeys = Array.from(new Set([
    ...Array.from(recentPeriodResourceCosts.keys()),
    ...Array.from(earlierPeriodResourceCosts.keys()),
  ]));
  const resourceRows = resourceKeys
    .map((key) => {
      const recentResource = recentPeriodResourceCosts.get(key);
      const earlierResource = earlierPeriodResourceCosts.get(key);
      return {
        resourceId: recentResource?.resourceId ?? earlierResource?.resourceId ?? key,
        recent: recentResource?.cost ?? 0,
        earlier: earlierResource?.cost ?? 0,
        change: (recentResource?.cost ?? 0) - (earlierResource?.cost ?? 0),
      };
    })
    .sort((first, second) => second.recent - first.recent || first.resourceId.localeCompare(second.resourceId))
    .map((resource) => ({ ...resource, current: resource.recent, previous: resource.earlier }));
  const serviceColors = ['#1598f7', '#a78bfa', '#19c9c1', '#facc15', '#c4b5fd', '#5eead4', '#818cf8'];
  const serviceChartData = serviceComparisonByRecency
    .filter((service) => selectedService === 'all' || service.name === selectedService)
    .slice()
    .sort((first, second) => second.recent - first.recent || first.name.localeCompare(second.name))
    .map((service, index) => ({
      ...service,
      current: service.recent,
      previous: service.earlier,
      color: serviceColors[index % serviceColors.length],
    }));
  const serviceTotal = serviceChartData.reduce((sum, service) => sum + service.recent, 0);
  const visibleResourceRows = selectedResourceId === 'all'
    ? resourceRows
    : resourceRows.filter((resource) =>
      resource.resourceId.toLowerCase() === selectedResourceId.toLowerCase(),
    );
  const recentResourceTotal = visibleResourceRows.reduce((sum, resource) => sum + resource.recent, 0);
  const earlierResourceTotal = visibleResourceRows.reduce((sum, resource) => sum + resource.earlier, 0);
  const resourceChange = recentResourceTotal - earlierResourceTotal;
  const resourceChangePercent = earlierResourceTotal
    ? (resourceChange / earlierResourceTotal) * 100
    : null;
  const topResources = visibleResourceRows.slice(0, 7);
  function getPeriodResourceList(isCostPeriod: boolean) {
    const map = isCostPeriod ? costPeriodResourceCosts : comparisonPeriodResourceCosts;
    return Array.from(map.values()).sort((first, second) =>
      second.cost - first.cost || first.resourceId.localeCompare(second.resourceId));
  }

  const compareCosts = useCallback(async () => {
    if (!subscriptionId || !rangesAreValid || comparisonRequestInProgress.current) return;
    comparisonRequestInProgress.current = true;
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        subscription_id: subscriptionId,
        start_date: startDate,
        end_date: endDate,
        comparison_start_date: comparisonStartDate,
        comparison_end_date: comparisonEndDate,
        granularity: 'Daily',
        compare: 'true',
      });
      const response = await fetch(`/api/costs?${params}`, { cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const retryAfter = response.headers.get('Retry-After');
        const retryMessage = retryAfter ? ` Retry after ${retryAfter} seconds.` : '';
        throw new Error(`${payload.detail ?? `Request failed (${response.status}).`}${retryMessage}`);
      }
      const result = payload as Omit<CostData, 'granularity'> & {
        granularity: 'Daily' | 'Monthly';
      };
      if (
        result.range.from !== startDate ||
        result.range.to !== endDate ||
        result.previousRange?.from !== comparisonStartDate ||
        result.previousRange?.to !== comparisonEndDate
      ) {
        setCostData(null);
        throw new Error(
          'The backend returned dates that do not match your selections. Restart the backend so it loads the latest comparison code, then try again.',
        );
      }
      setSelectedService((current) =>
        current !== 'all' && !result.serviceComparison.some((service) => service.name === current)
          ? 'all'
          : current,
      );
      setSelectedResourceId('all');
      setCostData({ ...result, granularity });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not compare Azure costs.');
    } finally {
      comparisonRequestInProgress.current = false;
      setBusy(false);
    }
  }, [
    comparisonEndDate,
    comparisonStartDate,
    endDate,
    granularity,
    rangesAreValid,
    startDate,
    subscriptionId,
  ]);

  async function loadAvailableServices() {
    if (!subscriptionId || !rangesAreValid || serviceLookupInProgress.current) return;
    serviceLookupInProgress.current = true;
    setLoadingServices(true);
    setError(null);
    try {
      const ranges = [
        { start: startDate, end: endDate },
        { start: comparisonStartDate, end: comparisonEndDate },
      ];
      const servicesByName = new Map<string, AvailableService>();
      for (const range of ranges) {
        const params = new URLSearchParams({
          subscription_id: subscriptionId,
          start_date: range.start,
          end_date: range.end,
          granularity: 'Daily',
          compare: 'false',
        });
        const response = await fetch(`/api/costs?${params}`, { cache: 'no-store' });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          const retryAfter = response.headers.get('Retry-After');
          const retryMessage = retryAfter ? ` Retry after ${retryAfter} seconds.` : '';
          throw new Error(`${payload.detail ?? `Could not load Azure services (${response.status}).`}${retryMessage}`);
        }
        const result = payload as { byService?: AvailableService[] };
        (result.byService ?? []).forEach((service) => {
          const current = servicesByName.get(service.name);
          servicesByName.set(service.name, {
            name: service.name,
            cost: (current?.cost ?? 0) + service.cost,
          });
        });
      }
      setAvailableServices({
        key: serviceLookupKey,
        services: Array.from(servicesByName.values())
          .sort((first, second) => second.cost - first.cost || first.name.localeCompare(second.name)),
      });
      setSelectedService('all');
      setSelectedResourceId('all');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not load Azure services.');
    } finally {
      serviceLookupInProgress.current = false;
      setLoadingServices(false);
    }
  }

  function updateComparisonDate(setter: (value: string) => void, value: string) {
    setter(value);
    setSelectedService('all');
    setSelectedResourceId('all');
    setAvailableServices(null);
    setError(null);
  }

  function exportBillingCsv() {
    if (!costData) return;
    if (selectedService !== 'all' && !costData.serviceComparison.some((service) => service.name === selectedService)) {
      setError('The selected Azure service is not present in the comparison results. Run the comparison again.');
      return;
    }

    type ResourceCost = {
      resourceId: string;
      cost: number;
    };
    const resourceCostsByPeriod = (trends: NonNullable<CostData['serviceResourceTrend']>) => {
      const costs = new Map<string, Map<string, ResourceCost>>();
      trends.forEach((trend) => {
        const periodCosts = new Map<string, ResourceCost>();
        const services = trend.services.filter((service) =>
          selectedService === 'all' || service.name === selectedService,
        );
        services.forEach((service) => {
          service.resources
            .filter((resource) =>
              selectedResourceId === 'all' ||
              resource.resourceId.toLowerCase() === selectedResourceId.toLowerCase(),
            )
            .forEach((resource) => {
              const key = resource.resourceId.toLowerCase();
              const existing = periodCosts.get(key);
              periodCosts.set(key, {
                resourceId: existing?.resourceId ?? resource.resourceId,
                cost: (existing?.cost ?? 0) + resource.cost,
              });
            });
        });
        costs.set(trend.period, periodCosts);
      });
      return costs;
    };
    const selectedPeriods = billingPeriodsInRange(
      costData.range.from,
      costData.range.to,
    );
    const comparedPeriods = costData.previousRange
      ? billingPeriodsInRange(
        costData.previousRange.from,
        costData.previousRange.to,
      )
      : [];
    const selectedCosts = resourceCostsByPeriod(costData.serviceResourceTrend ?? []);
    const comparedCosts = resourceCostsByPeriod(costData.previousServiceResourceTrend ?? []);
    const selectedRangeHeader = billingRangeHeader(costData.range.from, costData.range.to);
    const comparedRangeHeader = costData.previousRange
      ? billingRangeHeader(costData.previousRange.from, costData.previousRange.to)
      : 'Compared Period';
    const rows: (string | number)[][] = [[
      selectedRangeHeader,
      'Selected Cost',
      comparedRangeHeader,
      'Selected Cost',
      'Resource Name',
      'Compared Cost',
      'Difference',
    ]];

    for (let index = 0; index < Math.max(selectedPeriods.length, comparedPeriods.length); index += 1) {
      const selectedPeriod = selectedPeriods[index] ?? '';
      const comparedPeriod = comparedPeriods[index] ?? '';
      const selectedPeriodCosts = selectedCosts.get(selectedPeriod) ?? new Map<string, ResourceCost>();
      const comparedPeriodCosts = comparedCosts.get(comparedPeriod) ?? new Map<string, ResourceCost>();
      const resourceKeys = Array.from(new Set([
        ...Array.from(selectedPeriodCosts.keys()),
        ...Array.from(comparedPeriodCosts.keys()),
      ])).sort((first, second) => first.localeCompare(second));

      for (const resourceKey of resourceKeys) {
        const selectedResource = selectedPeriodCosts.get(resourceKey);
        const comparedResource = comparedPeriodCosts.get(resourceKey);
        const resourceExistsInBothPeriods = selectedResource !== undefined && comparedResource !== undefined;
        rows.push([
          selectedPeriod ? csvPeriodDate(selectedPeriod) : '',
          selectedResource?.cost ?? '',
          comparedPeriod ? csvPeriodDate(comparedPeriod) : '',
          comparedResource?.cost ?? '',
          resourceNameFromId(selectedResource?.resourceId ?? comparedResource?.resourceId ?? ''),
          resourceExistsInBothPeriods ? comparedResource.cost : '',
          resourceExistsInBothPeriods ? selectedResource.cost - comparedResource.cost : '',
        ]);
      }
    }

    const csv = rows
      .map((row) => row.map((field) => `"${String(field).replaceAll('"', '""')}"`).join(','))
      .join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    const serviceFileName = selectedService === 'all'
      ? 'all-services'
      : selectedService.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    link.download = `azure-cost-billing-${serviceFileName}-${costData.range.from}-to-${costData.range.to}-vs-${costData.previousRange?.from}-to-${costData.previousRange?.to}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  if (loading) return <main className="flex min-h-screen items-center justify-center p-6"><AzureConnectionLoader /></main>;

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-5 sm:px-6">
      <div className="mx-auto max-w-6xl space-y-5">
        <button
          type="button"
          className="secondary-button gap-2 rounded-xl border border-sky-700 bg-sky-950/70 px-4 py-2"
          onClick={() => {
            if (window.history.length > 1) router.back();
            else router.push('/');
          }}
        >
          <ArrowLeft size={20} className="text-cyan-300" aria-hidden="true" />
          Back
        </button>
        <header className="relative flex flex-col gap-4 overflow-hidden rounded-2xl border border-sky-500/80 bg-[radial-gradient(ellipse_at_78%_100%,rgba(0,148,255,0.2),transparent_38%),linear-gradient(110deg,rgba(3,38,70,0.98),rgba(4,26,54,0.97)_58%,rgba(2,17,37,0.98))] p-5 shadow-[0_16px_50px_rgba(0,140,255,0.1)] sm:p-6 md:flex-row md:items-center md:justify-between">
          <div className="relative z-10">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-cyan-300 sm:text-sm">Cost analysis</p>
            <h1 className="mt-1 text-2xl font-bold text-white sm:text-3xl">Compare cost periods</h1>
            <p className="mt-1 text-sm text-sky-100/90">
              Subscription: {subscriptionId ?? 'No subscription selected'}
            </p>
          </div>
          <nav aria-label="Comparison page navigation" className="relative z-10 flex flex-wrap gap-3">
            <Link href="/" className="secondary-button gap-3 rounded-2xl border-2 border-sky-600/90 bg-sky-950/60 px-5 py-3 text-base shadow-[0_0_18px_rgba(14,165,233,0.12)]">
              <Home size={25} className="text-cyan-300" aria-hidden="true" />Dashboard
            </Link>
            <Link href="/resources" className="secondary-button gap-3 rounded-2xl border-2 border-sky-600/90 bg-sky-950/60 px-5 py-3 text-base shadow-[0_0_18px_rgba(14,165,233,0.12)]">
              <Boxes size={25} className="text-cyan-300" aria-hidden="true" />Resource Inventory
            </Link>
            {auth?.connected && <DisconnectButton />}
          </nav>
          <svg aria-hidden="true" className="pointer-events-none absolute bottom-0 right-0 h-20 w-[72%] sm:h-24" viewBox="0 0 720 130" fill="none" preserveAspectRatio="none">
            <defs>
              <linearGradient id="compare-header-wave-fill" x1="0" y1="0" x2="720" y2="130" gradientUnits="userSpaceOnUse">
                <stop stopColor="#0787e8" stopOpacity=".02" />
                <stop offset="1" stopColor="#0787e8" stopOpacity=".32" />
              </linearGradient>
            </defs>
            <path d="M0 129C105 108 175 43 275 45c112 2 156 78 260 65 74-9 111-51 185-84v104H0Z" fill="url(#compare-header-wave-fill)" />
            <path d="M0 129C105 108 175 43 275 45c112 2 156 78 260 65 74-9 111-51 185-84" stroke="#08bdf5" strokeOpacity=".6" strokeWidth="2" />
          </svg>
        </header>

        {!auth?.connected ? (
          <section className="dashboard-card">
            <h2 className="text-xl font-semibold text-white">Connect Azure to compare costs</h2>
            <Link href="/connect-azure" className="primary-button mt-4">Connect Azure</Link>
          </section>
        ) : !subscriptionId ? (
          <section className="dashboard-card">
            <h2 className="text-xl font-semibold text-white">Choose a subscription</h2>
            <p className="mt-2 text-sm text-slate-300">Select a subscription before comparing cost periods.</p>
            <Link href="/connect-azure" className="primary-button mt-4">Set up Azure connection</Link>
          </section>
        ) : (
          <>
            <section className="space-y-5 rounded-2xl border border-sky-700/80 bg-[linear-gradient(145deg,rgba(9,35,59,0.9),rgba(5,20,39,0.94))] p-4 shadow-soft sm:p-6">
              <div className="flex items-center gap-4">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-cyan-500/30 bg-cyan-500/15 text-cyan-300">
                  <CalendarDays size={28} aria-hidden="true" />
                </span>
                <div>
                  <h2 className="text-xl font-bold text-white">Choose both date ranges</h2>
                  <p className="mt-1 text-sm text-sky-100/80">
                  Comparison dates are entered manually; the app will not choose a previous period for you.
                  </p>
                </div>
              </div>
              <div className="grid gap-5 lg:grid-cols-2">
                <fieldset className="overflow-hidden rounded-2xl border border-cyan-500/90 bg-slate-950/40">
                  <legend className="flex w-full items-center gap-3 bg-cyan-600/20 px-4 py-3 text-base font-bold text-white">
                    <CalendarDays size={25} className="text-cyan-300" aria-hidden="true" />Cost period
                  </legend>
                  <div className="grid gap-4 p-4 sm:grid-cols-2">
                  <label className="text-sm font-medium text-slate-200">
                    Start date
                    <input
                      className="mt-2 h-12 w-full rounded-xl border border-sky-800 bg-slate-950/80 px-3 text-white outline-none transition focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400/40"
                      type="date"
                      value={startDate}
                      max={endDate < dateOffset(0) ? endDate : dateOffset(0)}
                      onChange={(event) => updateComparisonDate(setStartDate, event.target.value)}
                    />
                  </label>
                  <label className="text-sm font-medium text-slate-200">
                    End date
                    <input
                      className="mt-2 h-12 w-full rounded-xl border border-sky-800 bg-slate-950/80 px-3 text-white outline-none transition focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400/40"
                      type="date"
                      value={endDate}
                      min={startDate}
                      max={dateOffset(0)}
                      onChange={(event) => updateComparisonDate(setEndDate, event.target.value)}
                    />
                  </label>
                  </div>
                </fieldset>
                <fieldset className="overflow-hidden rounded-2xl border border-violet-500/90 bg-slate-950/40">
                  <legend className="flex w-full items-center gap-3 bg-violet-500/20 px-4 py-3 text-base font-bold text-white">
                    <ArrowLeftRight size={25} className="text-violet-300" aria-hidden="true" />Compare against
                  </legend>
                  <div className="grid gap-4 p-4 sm:grid-cols-2">
                  <label className="text-sm font-medium text-slate-200">
                    Start date
                    <input
                      className="mt-2 h-12 w-full rounded-xl border border-violet-800 bg-slate-950/80 px-3 text-white outline-none transition focus:border-violet-400 focus:ring-1 focus:ring-violet-400/40"
                      type="date"
                      value={comparisonStartDate}
                      max={comparisonEndDate && comparisonEndDate < dateOffset(0) ? comparisonEndDate : dateOffset(0)}
                      onChange={(event) => updateComparisonDate(setComparisonStartDate, event.target.value)}
                    />
                  </label>
                  <label className="text-sm font-medium text-slate-200">
                    End date
                    <input
                      className="mt-2 h-12 w-full rounded-xl border border-violet-800 bg-slate-950/80 px-3 text-white outline-none transition focus:border-violet-400 focus:ring-1 focus:ring-violet-400/40"
                      type="date"
                      value={comparisonEndDate}
                      min={comparisonStartDate || undefined}
                      max={dateOffset(0)}
                      onChange={(event) => updateComparisonDate(setComparisonEndDate, event.target.value)}
                    />
                  </label>
                  </div>
                </fieldset>
              </div>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
                <label className="text-sm font-semibold text-slate-200 sm:w-64">
                  <span className="flex items-center gap-2">
                    <TrendingUp size={23} className="text-cyan-400" aria-hidden="true" />Billing display
                  </span>
                  <select
                    className="mt-2 h-12 w-full rounded-xl border border-sky-800 bg-slate-950/80 px-4 text-white outline-none focus:border-cyan-400"
                    value={granularity}
                    onChange={(event) => setGranularity(event.target.value as BillingDisplay)}
                  >
                    <option value="Cumulative">Cumulative</option>
                    <option value="Daily">Daily</option>
                  </select>
                </label>
                <label className="text-sm font-semibold text-slate-200 sm:w-64">
                  <span className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2">
                      <Boxes size={21} className="text-cyan-400" aria-hidden="true" />Azure service
                    </span>
                    <button
                      type="button"
                      className="text-xs font-semibold text-cyan-300 underline decoration-cyan-700 underline-offset-4 hover:text-cyan-100 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={!rangesAreValid || !subscriptionId || loadingServices || busy}
                      onClick={() => void loadAvailableServices()}
                    >
                      {loadingServices
                        ? 'Loading...'
                        : availableServices?.key === serviceLookupKey
                          ? 'Refresh list'
                          : 'Load services'}
                    </button>
                  </span>
                  <select
                    className="mt-2 h-12 w-full rounded-xl border border-sky-800 bg-slate-950/80 px-4 text-white outline-none focus:border-cyan-400"
                    value={selectedService}
                    disabled={loadingServices || busy}
                    onChange={(event) => {
                      setSelectedService(event.target.value);
                      setSelectedResourceId('all');
                    }}
                  >
                    <option value="all">All services</option>
                    {serviceOptions.length === 0 && (
                      <option value="loading" disabled>
                        {loadingServices
                          ? 'Loading services for selected dates...'
                          : 'Load services to choose one'}
                      </option>
                    )}
                    {serviceOptions.map((service) => (
                      <option key={service.name} value={service.name}>{service.name}</option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="primary-button min-h-12 gap-2 rounded-xl bg-gradient-to-r from-sky-500 to-blue-600 px-6 text-base font-semibold shadow-lg shadow-blue-950/40"
                  disabled={!rangesAreValid || busy || loadingServices}
                  onClick={() => void compareCosts()}
                >
                  <ArrowLeftRight size={23} aria-hidden="true" />
                  {busy ? 'Loading comparison...' : 'Compare these date ranges'}
                </button>
                {costData && (
                  <button
                    type="button"
                    className="secondary-button min-h-12 gap-2"
                    disabled={busy || comparisonNeedsRefresh}
                    onClick={exportBillingCsv}
                    title={selectedService === 'all'
                      ? 'Export the current report for all Azure services'
                      : `Export the current report for ${selectedService} only`}
                  >
                    <Download size={18} aria-hidden="true" />
                    {selectedService === 'all' ? 'Export all services' : 'Export selected service'}
                  </button>
                )}
              </div>
              {comparisonNeedsRefresh && (
                <p role="status" className="rounded-xl border border-cyan-800/70 bg-cyan-950/30 px-4 py-3 text-sm text-cyan-100">
                  Selections changed. Choose the billing display and service, then click Compare to update the results.
                </p>
              )}
              {!rangesAreValid && (
                <p className={`flex items-center gap-3 rounded-xl border px-4 py-3 text-sm ${
                  rangesOverlap
                    ? 'border-amber-600/50 bg-amber-950/30 text-amber-200'
                    : 'border-sky-700 bg-sky-950/40 text-slate-200'
                }`}>
                  <Info size={23} className={rangesOverlap ? 'shrink-0 text-amber-300' : 'shrink-0 text-cyan-400'} aria-hidden="true" />
                  {rangesOverlap
                    ? 'The cost and comparison periods overlap. Select two separate date ranges.'
                    : 'Enter valid dates for both periods. Future dates cannot be compared.'}
                </p>
              )}
            </section>

            {error && <div role="alert" className="rounded-xl border border-red-800 bg-red-950/60 p-4 text-red-200">{error}</div>}

            {costData && (
              <>
                {selectedService === 'all' ? (
                  <section className="relative isolate overflow-hidden rounded-2xl border-2 border-sky-500/90 bg-[radial-gradient(ellipse_at_82%_100%,rgba(0,148,255,0.2),transparent_42%),linear-gradient(115deg,rgba(3,38,70,0.98),rgba(4,26,54,0.97)_58%,rgba(2,17,37,0.98))] p-4 shadow-[0_16px_50px_rgba(0,140,255,0.1)]">
                    <svg aria-hidden="true" className="pointer-events-none absolute bottom-0 right-0 -z-10 h-24 w-full text-sky-400/20 sm:h-32" viewBox="0 0 1200 140" fill="none" preserveAspectRatio="none">
                      <path d="M0 125C155 108 195 54 330 66s169 57 310 43 183-70 313-76 169 44 247 22v85H0z" fill="currentColor" />
                      <path d="M0 125C155 108 195 54 330 66s169 57 310 43 183-70 313-76 169 44 247 22" stroke="#06b6d4" strokeOpacity=".8" strokeWidth="2" />
                    </svg>
                    <header className="relative z-10 mb-4 flex items-center gap-3 border-b border-cyan-400/60 pb-3">
                      <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl border-2 border-cyan-500/80 bg-cyan-500/15 text-cyan-300">
                        <TrendingUp size={24} strokeWidth={2.5} aria-hidden="true" />
                      </span>
                      <span className="hidden h-12 w-0.5 bg-cyan-400 sm:block" aria-hidden="true" />
                      <div>
                        <h2 className="text-lg font-bold text-white sm:text-xl">Top 3 Services by Spend</h2>
                        <p className="mt-1 text-sm text-sky-200">
                          Highest service costs in the selected periods.
                        </p>
                      </div>
                    </header>
                    <div className="relative z-10 grid gap-3 lg:grid-cols-2">
                      {[
                        {
                          title: 'Most Recent Period',
                          range: recentRange,
                          services: topServices,
                          amount: 'recent' as const,
                          cardStyle: 'border-cyan-400/90 bg-gradient-to-br from-sky-950/90 via-blue-950/80 to-slate-950/85',
                          iconStyle: 'bg-cyan-500/20 text-cyan-300',
                          barStyle: 'bg-gradient-to-r from-cyan-400 to-sky-500',
                        },
                        {
                          title: 'Earlier Period',
                          range: earlierRange,
                          services: comparisonTopServices,
                          amount: 'earlier' as const,
                          cardStyle: 'border-violet-500/90 bg-gradient-to-br from-indigo-950/90 via-violet-950/60 to-slate-950/85',
                          iconStyle: 'bg-violet-500/20 text-violet-300',
                          barStyle: 'bg-gradient-to-r from-violet-500 to-fuchsia-400',
                        },
                      ].map((period) => {
                        const maxCost = Math.max(...period.services.map((service) => service[period.amount]), 0);
                        return (
                          <article key={period.title} className={`overflow-hidden rounded-xl border-2 shadow-[0_10px_30px_rgba(0,0,0,0.2)] ${period.cardStyle}`}>
                            <header className="flex items-center gap-3 border-b border-white/10 px-3 py-2.5">
                              <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-white/10 ${period.iconStyle}`}>
                                <CalendarDays size={22} aria-hidden="true" />
                              </span>
                              <div>
                                <h3 className="text-base font-bold text-white sm:text-lg">{period.title}</h3>
                                <p className="mt-0.5 text-xs text-sky-200 sm:text-sm">
                                {period.range ? `${period.range.from} – ${period.range.to}` : 'No comparison period'}
                                </p>
                              </div>
                            </header>
                            {period.services.length === 0 ? (
                              <p className="p-3 text-sm text-slate-400">No service costs found for this period.</p>
                            ) : (
                              <ol className="divide-y divide-white/10 px-3">
                                {period.services.map((service, index) => {
                                  const amount = service[period.amount];
                                  const width = maxCost > 0 ? `${(amount / maxCost) * 100}%` : '0%';
                                  const normalizedName = service.name.toLowerCase();
                                  const ServiceIcon = /database|mysql|sql|cosmos|postgres/.test(normalizedName)
                                    ? Database
                                    : /virtual machine|vm\b|compute/.test(normalizedName)
                                      ? Server
                                      : Layers;
                                  return (
                                    <li key={service.name} className="flex items-center gap-3 py-2.5">
                                      <ServiceIcon className={period.amount === 'recent' ? 'h-6 w-6 shrink-0 text-cyan-400' : 'h-6 w-6 shrink-0 text-violet-400'} aria-hidden="true" />
                                      <div className="min-w-0 flex-1">
                                        <div className="flex items-center justify-between gap-3">
                                          <span className="min-w-0 truncate text-sm font-semibold text-white" title={service.name}>
                                            {index + 1}. {service.name}
                                          </span>
                                          <span className="whitespace-nowrap text-sm font-bold text-white">
                                          {currency(amount, costData.currency)}
                                          </span>
                                        </div>
                                        <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800/90">
                                          <span className={`block h-full rounded-full ${period.barStyle}`} style={{ width }} />
                                        </div>
                                      </div>
                                    </li>
                                  );
                                })}
                              </ol>
                            )}
                          </article>
                        );
                      })}
                    </div>
                  </section>
                ) : (
                <section className="dashboard-card">
                  <div className="mb-4">
                    <h2 className="text-lg font-semibold text-white">Resources by service</h2>
                    <p className="mt-1 text-sm text-slate-400">
                      Resource lists are sorted by cost. Select a resource to filter its billing details.
                    </p>
                  </div>
                  {selectedResourceId !== 'all' && (
                    <button
                      type="button"
                      onClick={() => setSelectedResourceId('all')}
                      className="mb-3 rounded-lg border border-slate-600 px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-cyan-400 hover:text-cyan-200"
                    >
                      Show all resources
                    </button>
                  )}
                  <div className="grid gap-4 lg:grid-cols-2">
                    {[
                      {
                        title: 'Most Recent Period',
                        range: recentRange,
                        resources: getPeriodResourceList(costPeriodIsRecent),
                        accent: 'border-sky-500/70 bg-sky-950/20',
                      },
                      {
                        title: 'Earlier Period',
                        range: earlierRange,
                        resources: getPeriodResourceList(!costPeriodIsRecent),
                        accent: 'border-violet-500/70 bg-violet-950/15',
                      },
                    ].map((period) => (
                      <article key={period.title} className={`overflow-hidden rounded-xl border ${period.accent}`}>
                        <header className="border-b border-slate-700/80 px-4 py-3">
                          <h3 className="font-semibold text-white">{period.title}</h3>
                          <p className="mt-1 text-xs text-slate-400">
                            {period.range ? `${period.range.from} – ${period.range.to}` : 'No comparison period'}
                          </p>
                        </header>
                        {period.resources.length === 0 ? (
                          <p className="p-4 text-sm text-slate-400">No resources found for this service and period.</p>
                        ) : (
                          <ol className="max-h-64 divide-y divide-slate-800 overflow-y-auto px-4">
                            {period.resources.map((resource, index) => (
                              <li key={resource.resourceId}>
                                <button
                                  type="button"
                                  aria-pressed={selectedResourceId.toLowerCase() === resource.resourceId.toLowerCase()}
                                  onClick={() => setSelectedResourceId((selected) =>
                                    selected.toLowerCase() === resource.resourceId.toLowerCase() ? 'all' : resource.resourceId,
                                  )}
                                  className={`flex w-full items-center gap-3 py-2.5 text-left ${
                                    selectedResourceId.toLowerCase() === resource.resourceId.toLowerCase()
                                      ? 'text-cyan-200'
                                      : 'text-slate-200'
                                  }`}
                                >
                                  <span className="w-6 shrink-0 text-xs text-slate-500">{index + 1}.</span>
                                  <span className="min-w-0 flex-1 truncate text-sm" title={resource.resourceId}>
                                    {resourceNameFromId(resource.resourceId)}
                                  </span>
                                  <span className="whitespace-nowrap text-sm font-semibold">
                                    {currency(resource.cost, costData.currency)}
                                  </span>
                                </button>
                              </li>
                            ))}
                          </ol>
                        )}
                      </article>
                    ))}
                  </div>
                </section>
                )}

                <section className="dashboard-card">
                  {costData.granularity === 'Daily' && (
                    <>
                  <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="text-lg font-semibold text-white">Billing details by day</h2>
                      <p className="mt-1 text-sm text-slate-400">
                        {selectedService === 'all' ? 'All services' : selectedService}
                        {selectedResourceId === 'all'
                          ? ' · All resources'
                          : ` · ${resourceNameFromId(selectedResourceId)}`}
                      </p>
                    </div>
                  </div>
                  <div className="grid gap-4 xl:grid-cols-2">
                    {[
                      {
                        isCostPeriod: true,
                        label: `Cost period (${costData.range.from} – ${costData.range.to})`,
                        rows: costData.trend,
                        servicesByPeriod: costData.serviceTrend ?? [],
                        resourcesByServiceAndPeriod: costData.serviceResourceTrend ?? [],
                      },
                      {
                        isCostPeriod: false,
                        label: `Comparison period (${costData.previousRange?.from} – ${costData.previousRange?.to})`,
                        rows: costData.previousTrend ?? [],
                        servicesByPeriod: costData.previousServiceTrend ?? [],
                        resourcesByServiceAndPeriod: costData.previousServiceResourceTrend ?? [],
                      },
                    ]
                      .sort((first, second) =>
                        Number(second.isCostPeriod === costPeriodIsRecent) -
                        Number(first.isCostPeriod === costPeriodIsRecent),
                      )
                      .map(({ isCostPeriod, label, rows, servicesByPeriod, resourcesByServiceAndPeriod }) => {
                      let cumulativeTotal = 0;
                      let previousCumulativeTotal = 0;
                      const cumulativeServices = new Map<string, {
                        name: string;
                        cost: number;
                        resources: Map<string, { resourceId: string; cost: number }>;
                      }>();
                      return (
                      <div key={label} className="min-w-0 rounded-xl border border-sky-900/70 bg-slate-950/45 p-2 sm:p-3">
                          <div className="overflow-hidden rounded-lg border border-slate-800">
                            <div className="grid grid-cols-[1.1fr_1fr_0.7fr_0.62fr] gap-2 bg-sky-950/70 px-3 py-2 text-[11px] font-medium text-slate-300 sm:px-4">
                              <span>Date</span>
                              <span className="text-right">
                                {costData.granularity === 'Cumulative' ? 'Cumulative Total' : 'Daily Total'}
                              </span>
                              <span className="text-right">Change</span>
                              <span className="text-right">Services</span>
                            </div>
                            <div className="max-h-[440px] overflow-y-auto px-2 sm:px-3">
                              {rows.length === 0 ? (
                                <p className="p-4 text-sm text-slate-400">
                                  No billing details were returned for this period.
                                </p>
                              ) : rows.map((row, index) => {
                                const services = servicesByPeriod.find(
                                  (item) => item.period === row.period,
                                )?.services ?? [];
                                const servicesWithResources = resourcesByServiceAndPeriod.find(
                                  (item) => item.period === row.period,
                                )?.services ?? [];
                                const dayBreakdown = filterBillingServices(
                                  services,
                                  servicesWithResources,
                                  selectedService,
                                  selectedResourceId,
                                );
                                const dayCost = dayBreakdown.total;
                                cumulativeTotal += dayCost;
                                dayBreakdown.services.forEach((service) => {
                                  const accumulatedService = cumulativeServices.get(service.name) ?? {
                                    name: service.name,
                                    cost: 0,
                                    resources: new Map<string, { resourceId: string; cost: number }>(),
                                  };
                                  accumulatedService.cost += service.cost;
                                  service.resources.forEach((resource) => {
                                    const key = resource.resourceId.toLowerCase();
                                    const accumulatedResource = accumulatedService.resources.get(key);
                                    accumulatedService.resources.set(key, {
                                      resourceId: accumulatedResource?.resourceId ?? resource.resourceId,
                                      cost: (accumulatedResource?.cost ?? 0) + resource.cost,
                                    });
                                  });
                                  cumulativeServices.set(service.name, accumulatedService);
                                });
                                const cumulativeBreakdown = {
                                  services: Array.from(cumulativeServices.values())
                                    .map((service) => ({
                                      ...service,
                                      resources: Array.from(service.resources.values())
                                        .sort((first, second) => second.cost - first.cost),
                                    }))
                                    .sort((first, second) => second.cost - first.cost),
                                  total: cumulativeTotal,
                                };
                                const displayedBreakdown = costData.granularity === 'Cumulative'
                                  ? cumulativeBreakdown
                                  : dayBreakdown;
                                const previousRow = rows[index - 1];
                                const previousBreakdown = previousRow
                                  ? filterBillingServices(
                                    servicesByPeriod.find((item) => item.period === previousRow.period)?.services ?? [],
                                    resourcesByServiceAndPeriod.find((item) => item.period === previousRow.period)?.services ?? [],
                                    selectedService,
                                    selectedResourceId,
                                  )
                                  : null;
                                const displayedCost = costData.granularity === 'Cumulative'
                                  ? cumulativeTotal
                                  : dayCost;
                                const previousCost = costData.granularity === 'Cumulative'
                                  ? previousCumulativeTotal
                                  : previousBreakdown?.total;
                                const changePercent = previousCost
                                  ? ((displayedCost - previousCost) / previousCost) * 100
                                  : null;
                                previousCumulativeTotal = cumulativeTotal;
                                return (
                                  <details
                                    key={row.period}
                                    open={index === 0}
                                    className="group border-b border-slate-800 last:border-b-0"
                                  >
                                    <summary className="grid cursor-pointer list-none grid-cols-[1.1fr_1fr_0.7fr_0.62fr] items-center gap-2 py-2.5 text-xs text-slate-200 marker:content-none hover:text-white sm:px-1">
                                      <span className="flex min-w-0 items-center gap-2 font-medium">
                                        <span className="text-slate-400 transition-transform group-open:rotate-90">›</span>
                                        <span className="truncate">{billingPeriodLabel(row.period)}</span>
                                      </span>
                                      <span className="whitespace-nowrap text-right font-medium">
                                        {currency(displayedCost, costData.currency)}
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
                                        {displayedBreakdown.services.length} {displayedBreakdown.services.length === 1 ? 'service' : 'services'}
                                      </span>
                                    </summary>
                                    <div className="mb-3 ml-2 rounded-lg border border-slate-800 bg-slate-900/65 p-3 sm:ml-5">
                                      {displayedBreakdown.services.length === 0 ? (
                                        <p className="text-xs text-slate-400">No billing details for this selection on this date.</p>
                                      ) : (
                                        <>
                                          {costData.granularity === 'Cumulative' && (
                                            <p className="mb-2 text-[10px] text-slate-400">
                                              Running totals from the start of this period
                                            </p>
                                          )}
                                          <div className="mb-2 grid grid-cols-[minmax(0,1fr)_auto_auto] gap-3 border-b border-slate-700/80 pb-2 text-[10px] uppercase tracking-wide text-slate-400">
                                            <span>Service</span>
                                            <span className="text-right">Cost</span>
                                            <span className="w-20 text-right">Share</span>
                                          </div>
                                          <div className="space-y-2.5">
                                            {displayedBreakdown.services.map((service) => {
                                              const share = displayedBreakdown.total > 0 ? (service.cost / displayedBreakdown.total) * 100 : 0;
                                              return (
                                                <details
                                                  key={`${row.period}-${service.name}`}
                                                  className="group/service rounded-md"
                                                >
                                                  <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 rounded-md py-1 text-xs marker:content-none hover:bg-slate-800/60">
                                                    <span className="flex min-w-0 items-center gap-2 text-slate-200">
                                                      <span className="text-slate-400 transition-transform group-open/service:rotate-90">›</span>
                                                      <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-sm bg-cyan-400" />
                                                      <span className="truncate" title={service.name}>{service.name}</span>
                                                    </span>
                                                    <span className="whitespace-nowrap text-right text-slate-200">
                                                      {currency(service.cost, costData.currency)}
                                                    </span>
                                                    <span className="flex w-20 items-center gap-1.5">
                                                      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800">
                                                        <span
                                                          className="block h-full rounded-full bg-cyan-400"
                                                          style={{ width: `${Math.min(100, Math.max(0, share))}%` }}
                                                        />
                                                      </span>
                                                      <span className="w-8 text-right text-[10px] text-slate-400">
                                                        {share.toFixed(1)}%
                                                      </span>
                                                    </span>
                                                  </summary>
                                                  <div className="mb-1 ml-5 mt-1 rounded-md border border-slate-800 bg-slate-950/60 p-2">
                                                    {service.resources.length === 0 ? (
                                                      <p className="text-[11px] text-slate-400">
                                                        No resource-level costs were returned for this service.
                                                      </p>
                                                    ) : (
                                                      <div className="space-y-1.5">
                                                        {service.resources.map((resource) => (
                                                          <div
                                                            key={`${row.period}-${service.name}-${resource.resourceId}`}
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
                      </div>
                      );
                    })}
                  </div>
                    </>
                  )}
                  {costData.granularity === 'Cumulative' && (
                    <div className={`mt-5 grid items-center gap-4 rounded-2xl border p-4 sm:grid-cols-[48px_minmax(0,1fr)_auto_auto] sm:gap-4 sm:p-5 ${
                      recentTotalChange > 0
                        ? 'border-rose-400/70 bg-gradient-to-r from-rose-950/80 via-red-950/65 to-slate-900/90 shadow-[0_0_30px_rgba(244,63,94,0.12)]'
                        : recentTotalChange < 0
                          ? 'border-emerald-400/70 bg-gradient-to-r from-emerald-950/80 via-teal-950/65 to-slate-900/90 shadow-[0_0_30px_rgba(16,185,129,0.12)]'
                          : 'border-slate-600 bg-slate-900/80'
                    }`}>
                      <span className={`grid h-12 w-12 shrink-0 place-items-center rounded-xl ${
                        recentTotalChange > 0
                          ? 'bg-rose-400/15 text-rose-300'
                          : recentTotalChange < 0
                            ? 'bg-emerald-400/15 text-emerald-300'
                            : 'bg-slate-700 text-slate-300'
                      }`}>
                        {recentTotalChange > 0
                          ? <TrendingUp size={26} aria-hidden="true" />
                          : recentTotalChange < 0
                            ? <ArrowDown size={26} aria-hidden="true" />
                            : <ArrowLeftRight size={26} aria-hidden="true" />}
                      </span>
                      <div className={`min-w-0 sm:border-l sm:pl-4 ${
                        recentTotalChange > 0
                          ? 'sm:border-rose-300/50'
                          : recentTotalChange < 0
                            ? 'sm:border-emerald-300/50'
                            : 'sm:border-slate-500'
                      }`}>
                        <p className="text-base font-bold text-white sm:text-lg">Difference between selected periods</p>
                        <p className="mt-1 text-xs text-slate-200 sm:text-sm">
                          {currency(recentTotal, costData.currency)} – {currency(earlierTotal, costData.currency)}
                        </p>
                      </div>
                      <p className={`text-xl font-bold sm:text-2xl ${
                        recentTotalChange > 0
                          ? 'text-rose-300'
                          : recentTotalChange < 0
                            ? 'text-emerald-300'
                            : 'text-white'
                      }`}>
                        {recentTotalChange > 0 ? '+' : ''}{currency(recentTotalChange, costData.currency)}
                      </p>
                      {recentTotalChangePercent !== null && (
                        <span className={`justify-self-start rounded-full border px-3 py-1.5 text-sm font-bold sm:justify-self-auto sm:text-base ${
                          recentTotalChangePercent > 0
                            ? 'border-rose-400/40 bg-rose-500/15 text-rose-300'
                            : recentTotalChangePercent < 0
                              ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-300'
                              : 'border-slate-500 bg-slate-800 text-slate-200'
                        }`}>
                          {recentTotalChangePercent > 0 ? '↑ ' : recentTotalChangePercent < 0 ? '↓ ' : ''}
                          {Math.abs(recentTotalChangePercent).toFixed(1)}%
                        </span>
                      )}
                    </div>
                  )}
                </section>

                <section className="dashboard-card border-sky-900/80 bg-gradient-to-br from-slate-900 via-slate-900 to-blue-950/40">
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <span className="grid h-10 w-10 place-items-center rounded-xl bg-sky-500/15 text-sky-300">
                        <Boxes size={22} aria-hidden="true" />
                      </span>
                      <div>
                        <h2 className="text-lg font-semibold text-white">Spend by Azure Service</h2>
                        <p className="text-sm text-slate-400">Change is calculated as the most recent period minus the earlier period.</p>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs">
                      <span className="rounded-lg border border-sky-800 bg-sky-950/60 px-3 py-2 text-slate-200">
                        <span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm bg-sky-500" />
                        Most Recent: {recentRange?.from} – {recentRange?.to}
                      </span>
                      <span className="rounded-lg border border-violet-800 bg-violet-950/40 px-3 py-2 text-slate-200">
                        <span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm bg-violet-400" />
                        Earlier: {earlierRange?.from} – {earlierRange?.to}
                      </span>
                    </div>
                  </div>
                  {costData.serviceComparison.length === 0 ? (
                    <p className="text-sm text-slate-400">Azure returned no service comparison for these periods.</p>
                  ) : (
                    <div className="grid gap-4 xl:grid-cols-[minmax(300px,0.8fr)_minmax(0,1.3fr)]">
                      <div className="flex min-h-[280px] items-center gap-3 rounded-xl border border-slate-700 bg-slate-950/40 p-3">
                        <div className="relative h-[250px] min-w-0 flex-1">
                          <ResponsiveContainer width="100%" height="100%">
                            <PieChart>
                              <Pie
                                data={serviceChartData}
                                dataKey="current"
                                nameKey="name"
                                innerRadius="58%"
                                outerRadius="92%"
                                paddingAngle={1}
                                stroke="none"
                              >
                                {serviceChartData.map((service) => (
                                  <Cell key={service.name} fill={service.color} />
                                ))}
                              </Pie>
                              <Tooltip
                                formatter={(value) => currency(Number(value), costData.currency)}
                                contentStyle={{
                                  backgroundColor: '#0f172a',
                                  borderColor: '#334155',
                                  borderRadius: 10,
                                  color: '#ffffff',
                                }}
                                itemStyle={{ color: '#ffffff' }}
                                labelStyle={{ color: '#ffffff' }}
                              />
                            </PieChart>
                          </ResponsiveContainer>
                          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                            <span className="text-lg font-bold text-white">{currency(serviceTotal, costData.currency)}</span>
                            <span className="text-center text-xs text-slate-400">Total Spend<br />(Most Recent Period)</span>
                          </div>
                        </div>
                        <div className="min-w-[115px] space-y-2">
                          {serviceChartData.slice(0, 7).map((service) => (
                            <div key={service.name} className="flex items-center gap-2 text-[11px]">
                              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: service.color }} />
                              <span className="max-w-[120px] truncate text-slate-200" title={service.name}>{service.name}</span>
                              <span className="ml-auto text-slate-400">
                                {serviceTotal ? `${((service.current / serviceTotal) * 100).toFixed(1)}%` : '0%'}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="max-h-[340px] overflow-auto rounded-xl border border-slate-700">
                        <table className="w-full min-w-[650px] text-left text-xs">
                          <thead className="sticky top-0 bg-slate-800 text-slate-300">
                            <tr>
                              <th scope="col" className="px-3 py-2.5 font-medium">Azure Service</th>
                              <th scope="col" className="px-3 py-2.5 text-right font-medium">
                                Most Recent<br /><span className="text-[10px] text-slate-400">{recentRange?.from} – {recentRange?.to}</span>
                              </th>
                              <th scope="col" className="px-3 py-2.5 text-right font-medium">
                                Earlier Period<br /><span className="text-[10px] text-slate-400">{earlierRange?.from} – {earlierRange?.to}</span>
                              </th>
                              <th scope="col" className="px-3 py-2.5 text-right font-medium">Change</th>
                              <th scope="col" className="px-3 py-2.5 text-right font-medium">Change %</th>
                            </tr>
                          </thead>
                          <tbody>
                            {serviceChartData.map((item) => {
                              const percent = item.earlier ? (item.change / item.earlier) * 100 : null;
                              const costIsHigher = item.change > 0;
                              const costIsLower = item.change < 0;
                              return (
                                <tr key={item.name} className="border-t border-slate-800 text-slate-200">
                                  <td className="px-3 py-2.5 font-medium">{item.name}</td>
                                  <td className="whitespace-nowrap px-3 py-2.5 text-right">{currency(item.recent, costData.currency)}</td>
                                  <td className="whitespace-nowrap px-3 py-2.5 text-right">{currency(item.earlier, costData.currency)}</td>
                                  <td className="whitespace-nowrap px-3 py-2.5 text-right">
                                    <span className={`rounded-full px-2 py-1 ${costIsHigher ? 'bg-rose-500/15 text-rose-300' : costIsLower ? 'bg-emerald-500/15 text-emerald-300' : 'text-slate-300'}`}>
                                      {item.change > 0 ? '↑ +' : item.change < 0 ? '↓ ' : ''}{currency(item.change, costData.currency)}
                                    </span>
                                  </td>
                                  <td className={`whitespace-nowrap px-3 py-2.5 text-right ${percent === null ? 'text-slate-400' : costIsHigher ? 'text-rose-300' : costIsLower ? 'text-emerald-300' : 'text-slate-300'}`}>
                                    {percent === null ? '—' : `${percent > 0 ? '↑ ' : percent < 0 ? '↓ ' : ''}${Math.abs(percent).toFixed(1)}%`}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </section>

                <section className="dashboard-card border-sky-900/80 bg-gradient-to-br from-slate-900 via-slate-900 to-blue-950/40">
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <span className="grid h-10 w-10 place-items-center rounded-xl bg-sky-500/15 text-sky-300">
                        <Database size={22} aria-hidden="true" />
                      </span>
                      <div>
                        <h2 className="text-lg font-semibold text-white">Resource Cost Comparison</h2>
                        <p className="text-sm text-slate-400">Change is calculated as the most recent period minus the earlier period.</p>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs">
                      <span className="rounded-lg border border-sky-800 bg-sky-950/60 px-3 py-2 text-slate-200">
                        <span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm bg-sky-500" />
                        Most Recent: {recentRange?.from} – {recentRange?.to}
                      </span>
                      <span className="rounded-lg border border-violet-800 bg-violet-950/40 px-3 py-2 text-slate-200">
                        <span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm bg-violet-400" />
                        Earlier: {earlierRange?.from} – {earlierRange?.to}
                      </span>
                    </div>
                  </div>
                  {visibleResourceRows.length === 0 ? (
                    <p className="text-sm text-slate-400">No resource-level cost comparisons were returned.</p>
                  ) : (
                    <>
                      <div className="mb-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                        <div className="rounded-xl border border-sky-700 bg-sky-950/40 p-3">
                          <p className="text-xs text-slate-300">Total Resources</p>
                          <p className="mt-1 text-xl font-bold text-white">{visibleResourceRows.length}</p>
                        </div>
                        <div className="rounded-xl border border-sky-700 bg-sky-950/40 p-3">
                          <p className="text-xs text-slate-300">Total Spend (Most Recent)</p>
                          <p className="mt-1 text-lg font-bold text-white">{currency(recentResourceTotal, costData.currency)}</p>
                        </div>
                        <div className="rounded-xl border border-sky-700 bg-sky-950/40 p-3">
                          <p className="text-xs text-slate-300">Earlier Period Spend</p>
                          <p className="mt-1 text-lg font-bold text-white">{currency(earlierResourceTotal, costData.currency)}</p>
                        </div>
                        <div className={`rounded-xl border p-3 ${resourceChange > 0 ? 'border-rose-700 bg-rose-950/40' : resourceChange < 0 ? 'border-emerald-700 bg-emerald-950/40' : 'border-slate-700 bg-slate-900/40'}`}>
                          <p className="text-xs text-slate-300">Total Change</p>
                          <p className={`mt-1 flex items-center gap-1 text-lg font-bold ${resourceChange > 0 ? 'text-rose-300' : resourceChange < 0 ? 'text-emerald-300' : 'text-slate-200'}`}>
                            {resourceChange < 0 ? <ArrowDown size={17} aria-hidden="true" /> : resourceChange > 0 ? <TrendingUp size={17} aria-hidden="true" /> : null}
                            {resourceChange > 0 ? '+' : ''}
                            {currency(resourceChange, costData.currency)}
                          </p>
                          <p className="text-xs text-slate-400">
                            {resourceChangePercent === null ? '—' : `${resourceChangePercent.toFixed(1)}%`}
                          </p>
                        </div>
                      </div>
                      <div className="grid gap-4 xl:grid-cols-[minmax(300px,0.9fr)_minmax(0,1fr)]">
                        <div className="rounded-xl border border-slate-700 bg-slate-950/40 p-3">
                          <h3 className="mb-2 text-sm font-semibold text-slate-200">Top Resources by Cost (Most Recent)</h3>
                          <div className="h-[270px]">
                            <ResponsiveContainer width="100%" height="100%">
                              <BarChart data={topResources} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 8 }}>
                                <XAxis type="number" tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={{ stroke: '#475569' }} tickLine={false} />
                                <YAxis
                                  type="category"
                                  dataKey="resourceId"
                                  width={130}
                                  tick={{ fill: '#cbd5e1', fontSize: 10 }}
                                  axisLine={false}
                                  tickLine={false}
                                  tickFormatter={resourceNameFromId}
                                />
                                <Tooltip
                                  formatter={(value) => currency(Number(value), costData.currency)}
                                  labelFormatter={(label) => resourceNameFromId(String(label))}
                                  contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', borderRadius: 10 }}
                                />
                                <Bar dataKey="current" fill="#1598f7" radius={[0, 4, 4, 0]} />
                              </BarChart>
                            </ResponsiveContainer>
                          </div>
                        </div>
                        <div className="max-h-[320px] overflow-auto rounded-xl border border-slate-700">
                          <table className="w-full min-w-[620px] text-left text-xs">
                            <thead className="sticky top-0 bg-slate-800 text-slate-300">
                              <tr>
                                <th scope="col" className="px-3 py-2.5 font-medium">Resource</th>
                                <th scope="col" className="px-3 py-2.5 text-right font-medium">
                                  Most Recent<br /><span className="text-[10px] text-slate-400">{recentRange?.from} – {recentRange?.to}</span>
                                </th>
                                <th scope="col" className="px-3 py-2.5 text-right font-medium">
                                  Earlier Period<br /><span className="text-[10px] text-slate-400">{earlierRange?.from} – {earlierRange?.to}</span>
                                </th>
                                <th scope="col" className="px-3 py-2.5 text-right font-medium">Change</th>
                                <th scope="col" className="px-3 py-2.5 text-right font-medium">Change %</th>
                              </tr>
                            </thead>
                            <tbody>
                              {visibleResourceRows.map((item) => {
                                const percent = item.earlier ? (item.change / item.earlier) * 100 : null;
                                const costIsHigher = item.change > 0;
                                const costIsLower = item.change < 0;
                                return (
                                  <tr key={item.resourceId} className="border-t border-slate-800 text-slate-200">
                                    <td className="max-w-[180px] truncate px-3 py-2.5 font-medium" title={item.resourceId}>
                                      {resourceNameFromId(item.resourceId)}
                                    </td>
                                    <td className="whitespace-nowrap px-3 py-2.5 text-right">{currency(item.recent, costData.currency)}</td>
                                    <td className="whitespace-nowrap px-3 py-2.5 text-right">{currency(item.earlier, costData.currency)}</td>
                                    <td className="whitespace-nowrap px-3 py-2.5 text-right">
                                      <span className={`rounded-full px-2 py-1 ${costIsHigher ? 'bg-rose-500/15 text-rose-300' : costIsLower ? 'bg-emerald-500/15 text-emerald-300' : 'text-slate-300'}`}>
                                        {item.change > 0 ? '↑ +' : item.change < 0 ? '↓ ' : ''}{currency(item.change, costData.currency)}
                                      </span>
                                    </td>
                                    <td className={`whitespace-nowrap px-3 py-2.5 text-right ${percent === null ? 'text-slate-400' : costIsHigher ? 'text-rose-300' : costIsLower ? 'text-emerald-300' : 'text-slate-300'}`}>
                                      {percent === null ? '—' : `${percent > 0 ? '↑ ' : percent < 0 ? '↓ ' : ''}${Math.abs(percent).toFixed(1)}%`}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </>
                  )}
                </section>
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
}
