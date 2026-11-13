import Image from 'next/image';

export function AzureConnectionLoader() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col items-center justify-center gap-2 text-slate-200"
    >
      <Image
        src="/azure-connection-logo.png"
        alt="Microsoft Azure"
        width={148}
        height={83}
        className="h-[66px] w-[118px] animate-pulse object-contain motion-reduce:animate-none"
      />
      <span className="text-sm font-medium">Connecting to Azure...</span>
      <span className="sr-only">Please wait while the Azure connection is checked.</span>
    </div>
  );
}
