import { useState } from 'react';

interface Props {
  text: string;
  peerCount: number;
  lastRemoteAt: number | null;
  onChange: (next: string) => void;
  /** Focus mode: editor grows to fill the viewport. */
  large?: boolean;
}

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

export function SharedEditor({ text, peerCount, lastRemoteAt, onChange, large }: Props) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  const copy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setCopyError(null);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyError('Copy failed — select the text and copy manually.');
    }
  };

  return (
    <section aria-label="Shared clipboard" className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Shared clipboard</h2>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          {peerCount === 0
            ? 'editing locally — connect a device to sync'
            : lastRemoteAt
              ? `peer update ${timeAgo(lastRemoteAt)}`
              : 'synced'}
        </span>
      </div>

      <label htmlFor="shared-text" className="sr-only">
        Shared text — edits sync to connected devices
      </label>
      <textarea
        id="shared-text"
        value={text}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Type here on one device — it appears on the other, live…"
        rows={large ? 18 : 8}
        className={`mt-3 w-full resize-y rounded-xl border border-zinc-300 bg-transparent p-3 font-mono text-sm leading-relaxed placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none dark:border-zinc-700 ${
          large ? 'min-h-[55dvh] text-base' : ''
        }`}
      />

      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          {text.length} character{text.length === 1 ? '' : 's'}
        </span>
        <button
          type="button"
          onClick={copy}
          disabled={!text}
          className="rounded-lg bg-zinc-900 px-4 py-2 text-xs font-semibold text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {copied ? 'Copied ✓' : 'Copy to clipboard'}
        </button>
      </div>
      {copyError && (
        <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
          {copyError}
        </p>
      )}
    </section>
  );
}
