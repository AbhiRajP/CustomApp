'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ArrowRight, Box, Download, Layers, RefreshCw } from 'lucide-react';
import { DisconnectButton } from '@/components/disconnect-button';

type Preferences = { subscriptionId: string | null };
type AzureResource = {
  id: string;
  name: string;
  type: string;
  resourceGroup: string;
  location: string;
  sku: string | null;
  tags: Record<string, string>;
};

function resourceGroupName(resource: AzureResource): string {
  const providedGroup = resource.resourceGroup?.trim();
  if (providedGroup) return providedGroup;

  const idParts = resource.id.split('/').filter(Boolean);
  const resourceGroupsIndex = idParts.findIndex((part) => part.toLowerCase() === 'resourcegroups');
  if (resourceGroupsIndex < 0 || !idParts[resourceGroupsIndex + 1]) return 'No resource group';

  try {
    return decodeURIComponent(idParts[resourceGroupsIndex + 1]);
  } catch {
    return idParts[resourceGroupsIndex + 1];
  }
}

function readableResourceType(type: string): string {
  const [provider = '', ...typeSegments] = type.split('/');
  if (!typeSegments.length) return type || 'Unknown type';

  const acronyms: Record<string, string> = {
    api: 'API',
    cidr: 'CIDR',
    dns: 'DNS',
    ip: 'IP',
    nsg: 'NSG',
    sql: 'SQL',
    vm: 'VM',
  };
  const readableSegment = (segment: string) =>
    segment
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => acronyms[word.toLowerCase()] ?? `${word[0].toUpperCase()}${word.slice(1)}`)
      .join(' ');
  const providerName = provider.replace(/^Microsoft\./i, '').replace(/^Azure\./i, '');

  return `${typeSegments.map(readableSegment).join(' / ')} (${readableSegment(providerName)})`;
}

async function apiRequest<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.detail ?? `Request failed (${response.status}).`);
  return payload as T;
}

export default function ResourceInventoryPage() {
  const router = useRouter();
  const [resources, setResources] = useState<AzureResource[]>([]);
  const [scope, setScope] = useState<Preferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedResourceGroup, setSelectedResourceGroup] = useState<string | null>(null);
  const [typeSortDirection, setTypeSortDirection] = useState<'ascending' | 'descending'>('ascending');
  const resourcesByGroup = useMemo(() => {
    const groups = new Map<string, { name: string; resources: AzureResource[] }>();
    for (const resource of resources) {
      const groupName = resourceGroupName(resource);
      const groupKey = groupName.toLowerCase();
      const group = groups.get(groupKey) ?? { name: groupName, resources: [] };
      group.resources.push(resource);
      groups.set(groupKey, group);
    }
    const entries: [string, AzureResource[]][] = [];
    groups.forEach(({ name, resources: groupResources }) => entries.push([name, groupResources]));
    return entries.sort(([first], [second]) => first.localeCompare(second));
  }, [resources]);
  const selectedGroupResources = useMemo(
    () => resourcesByGroup.find(([groupName]) => groupName === selectedResourceGroup)?.[1] ?? [],
    [resourcesByGroup, selectedResourceGroup],
  );
  const sortedGroupResources = useMemo(
    () =>
      [...selectedGroupResources].sort((first, second) => {
        const typeOrder = readableResourceType(first.type).localeCompare(
          readableResourceType(second.type),
          undefined,
          { sensitivity: 'base' },
        );
        const order = typeOrder || first.name.localeCompare(second.name, undefined, { sensitivity: 'base' });
        return typeSortDirection === 'ascending' ? order : -order;
      }),
    [selectedGroupResources, typeSortDirection],
  );

  async function loadResources() {
    setLoading(true);
    setError(null);
    setSelectedResourceGroup(null);
    try {
      const preferences = await apiRequest<Preferences>('/api/preferences');
      setScope(preferences);
      if (!preferences.subscriptionId) {
        setResources([]);
        return;
      }
      const query = new URLSearchParams({ subscription_id: preferences.subscriptionId });
      const response = await apiRequest<{ items: AzureResource[] }>(`/api/resources?${query}`);
      setResources(response.items);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not load Azure resources.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadResources();
  }, []);

  function exportResourcesCsv(exportResources: AzureResource[], filename: string) {
    const header = ['Name', 'Type', 'Resource group', 'Location', 'SKU', 'Tags'];
    const rows = exportResources.map((resource) => [
      resource.name,
      readableResourceType(resource.type),
      resourceGroupName(resource),
      resource.location,
      resource.sku ?? '',
      Object.entries(resource.tags).map(([key, value]) => `${key}=${value}`).join('; '),
    ]);
    const csv = [header, ...rows]
      .map((row) => row.map((field) => `"${String(field).replaceAll('"', '""')}"`).join(','))
      .join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function exportCsv() {
    exportResourcesCsv(resources, 'azure-resources.csv');
  }

  function exportSelectedGroupCsv() {
    if (!selectedResourceGroup || selectedGroupResources.length === 0) return;
    const filename = `azure-resources-${selectedResourceGroup}`
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
      .replace(/\s+/g, '-')
      .concat('.csv');
    exportResourcesCsv(selectedGroupResources, filename);
  }

  return (
    <main className="min-h-screen p-4 sm:p-6">
      <div className="mx-auto max-w-7xl space-y-5">
        <button
          type="button"
          className="secondary-button gap-2 rounded-xl border border-sky-700 bg-sky-950/60 px-4 py-2"
          onClick={() => {
            if (window.history.length > 1) router.back();
            else router.push('/');
          }}
        >
          <ArrowLeft size={20} className="text-cyan-300" aria-hidden="true" />
          Back
        </button>
        <header className="relative flex flex-col gap-3 overflow-hidden rounded-xl border border-cyan-500/90 bg-[radial-gradient(ellipse_at_78%_100%,rgba(0,148,255,0.2),transparent_38%),linear-gradient(110deg,rgba(3,38,70,0.98),rgba(4,26,54,0.97)_58%,rgba(2,17,37,0.98))] p-4 shadow-[0_12px_36px_rgba(0,140,255,0.08)] sm:flex-row sm:items-center sm:justify-between sm:p-5">
          <div className="relative z-10">
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-cyan-300 sm:text-xs">Inventory</p>
            <h1 className="mt-1 text-xl font-bold text-white sm:text-2xl">Azure Resource Inventory</h1>
            <p className="mt-1 text-xs text-sky-100/90 sm:text-sm">
              Subscription: {scope?.subscriptionId ?? 'No subscription'}
            </p>
          </div>
          <div className="relative z-10 flex flex-wrap gap-2">
            <button className="secondary-button gap-2 rounded-lg border border-sky-600/90 bg-sky-950/60 px-3 py-1.5 text-sm" disabled={!resources.length} onClick={exportCsv}>
              <Download size={18} className="text-cyan-300" aria-hidden="true" />Export CSV
            </button>
            <button className="primary-button gap-2 rounded-lg border border-cyan-400 px-3 py-1.5 text-sm" disabled={loading} onClick={() => void loadResources()}>
              <RefreshCw size={18} aria-hidden="true" />
              {loading ? 'Loading...' : 'Refresh inventory'}
            </button>
            <DisconnectButton />
          </div>
          <svg aria-hidden="true" className="pointer-events-none absolute bottom-0 right-0 h-16 w-[62%]" viewBox="0 0 720 130" fill="none" preserveAspectRatio="none">
            <defs>
              <linearGradient id="inventory-header-wave" x1="0" y1="0" x2="720" y2="130" gradientUnits="userSpaceOnUse">
                <stop stopColor="#0787e8" stopOpacity=".02" />
                <stop offset="1" stopColor="#0787e8" stopOpacity=".32" />
              </linearGradient>
            </defs>
            <path d="M0 129C105 108 175 43 275 45c112 2 156 78 260 65 74-9 111-51 185-84v104H0Z" fill="url(#inventory-header-wave)" />
            <path d="M0 129C105 108 175 43 275 45c112 2 156 78 260 65 74-9 111-51 185-84" stroke="#08bdf5" strokeOpacity=".6" strokeWidth="2" />
          </svg>
        </header>

        {error && <div role="alert" className="rounded-xl border border-red-800 bg-red-950/60 p-4 text-red-200">{error}</div>}

        {!loading && !scope?.subscriptionId ? (
          <section className="dashboard-card">
            <h2 className="text-xl font-semibold text-white">Select a subscription</h2>
            <p className="mt-2 text-sm text-slate-300">Connect Azure and choose a subscription to view its resources.</p>
            <Link href="/connect-azure" className="primary-button mt-4">Configure Azure connection</Link>
          </section>
        ) : (
          <section className="overflow-hidden rounded-xl border border-sky-600/90 bg-[linear-gradient(145deg,rgba(3,30,54,0.96),rgba(2,15,34,0.98))] p-3 shadow-[0_12px_36px_rgba(0,140,255,0.05)] sm:p-4">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border-2 border-cyan-500/70 bg-cyan-500/10 text-cyan-300">
                  <Layers size={24} aria-hidden="true" />
                </span>
                <div>
                  <h2 className="text-lg font-bold text-white sm:text-xl">
                    {selectedResourceGroup ? selectedResourceGroup : 'Resource groups'}
                  </h2>
                  {!selectedResourceGroup && (
                    <p className="mt-0.5 text-xs text-sky-100/75 sm:text-sm">
                      List of resource groups and the number of resources in each.
                    </p>
                  )}
                </div>
              </div>
              <span className="inline-flex items-center gap-2 rounded-full border border-cyan-500/80 bg-cyan-950/50 px-3 py-1.5 text-xs font-semibold text-cyan-200 sm:text-sm">
                <Layers size={17} aria-hidden="true" />
                {selectedResourceGroup ? selectedGroupResources.length : resources.length}{' '}
                {(selectedResourceGroup ? selectedGroupResources.length : resources.length) === 1 ? 'resource' : 'resources'}
              </span>
            </div>
            {loading ? <p className="text-sm text-slate-400">Loading resources from Azure...</p> : resources.length === 0 ? (
              <p className="text-sm text-slate-400">No resources were returned for this subscription.</p>
            ) : selectedResourceGroup ? (
              <div>
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <button
                    type="button"
                    className="secondary-button gap-2 rounded-xl border border-sky-700 bg-sky-950/60"
                    onClick={() => setSelectedResourceGroup(null)}
                  >
                    <ArrowLeft size={18} aria-hidden="true" />
                    Back to resource groups
                  </button>
                  <button
                    type="button"
                    className="secondary-button gap-2 rounded-xl border border-sky-600/90 bg-sky-950/60"
                    disabled={!selectedGroupResources.length}
                    onClick={exportSelectedGroupCsv}
                  >
                    <Download size={18} className="text-cyan-300" aria-hidden="true" />
                    Export group CSV
                  </button>
                </div>
                <div className="overflow-x-auto rounded-xl border border-slate-800">
                  <table className="w-full min-w-[900px] table-fixed text-left text-sm">
                    <thead className="sticky top-0 bg-slate-800 text-xs uppercase tracking-wide text-slate-300">
                      <tr>
                        <th scope="col" className="w-[25%] px-4 py-3 font-semibold">Name</th>
                        <th
                          scope="col"
                          aria-sort={typeSortDirection}
                          className="w-[30%] px-4 py-3 font-semibold"
                        >
                          <button
                            type="button"
                            className="inline-flex items-center gap-2 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
                            onClick={() =>
                              setTypeSortDirection((direction) =>
                                direction === 'ascending' ? 'descending' : 'ascending',
                              )
                            }
                          >
                            Type
                            <span aria-hidden="true">{typeSortDirection === 'ascending' ? '↑' : '↓'}</span>
                          </button>
                        </th>
                        <th scope="col" className="w-[16%] px-4 py-3 font-semibold">Location</th>
                        <th scope="col" className="w-[12%] px-4 py-3 font-semibold">SKU</th>
                        <th scope="col" className="w-[17%] px-4 py-3 font-semibold">Tags</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {sortedGroupResources.map((resource) => (
                        <tr key={resource.id} className="align-top text-slate-300 transition-colors hover:bg-slate-800/45">
                          <td className="break-words px-4 py-3.5 font-medium text-sky-400">{resource.name}</td>
                          <td className="break-words px-4 py-3.5 text-slate-200" title={resource.type}>
                            {readableResourceType(resource.type)}
                          </td>
                          <td className="px-4 py-3.5">{resource.location || '—'}</td>
                          <td className="break-words px-4 py-3.5">{resource.sku ?? '—'}</td>
                          <td className="break-words px-4 py-3.5">
                            {Object.entries(resource.tags).map(([key, value]) => `${key}=${value}`).join(', ') || '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {resourcesByGroup.map(([groupName, groupResources], index) => {
                  const cardAccent = [
                    'border-cyan-500/90 bg-gradient-to-br from-cyan-950/70 to-sky-950/50 text-cyan-300 hover:border-cyan-300',
                    'border-violet-500/90 bg-gradient-to-br from-violet-950/70 to-blue-950/50 text-violet-300 hover:border-violet-300',
                    'border-teal-500/90 bg-gradient-to-br from-teal-950/70 to-emerald-950/50 text-teal-300 hover:border-teal-300',
                    'border-amber-500/80 bg-gradient-to-br from-amber-950/60 to-slate-900/70 text-amber-300 hover:border-amber-300',
                    'border-sky-500/90 bg-gradient-to-br from-sky-950/70 to-blue-950/50 text-sky-300 hover:border-sky-300',
                  ][index % 5];
                  const resourceCount = `${groupResources.length} ${groupResources.length === 1 ? 'resource' : 'resources'}`;
                  return (
                  <button
                    key={groupName}
                    type="button"
                    className={`group flex min-h-24 items-center justify-between gap-3 rounded-xl border-2 p-3 text-left transition duration-200 hover:-translate-y-0.5 hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 ${cardAccent}`}
                    onClick={() => setSelectedResourceGroup(groupName)}
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-current/20 bg-slate-950/30">
                        <Box size={27} aria-hidden="true" />
                      </span>
                      <span className="min-w-0">
                        <span className="block break-words text-sm font-bold leading-5 text-white">{groupName}</span>
                        <span className="mt-1.5 inline-flex rounded-full border border-current/40 bg-slate-950/25 px-2.5 py-0.5 text-xs font-medium text-slate-100">
                          {resourceCount}
                        </span>
                      </span>
                    </span>
                    <ArrowRight className="shrink-0 transition-transform group-hover:translate-x-1" size={21} aria-hidden="true" />
                  </button>
                  );
                })}
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
