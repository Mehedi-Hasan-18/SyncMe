import { SharedEditor } from './SharedEditor';

export interface FocusDevice {
  peerId: string;
  name: string;
}

interface Props {
  devices: FocusDevice[];
  text: string;
  peerCount: number;
  lastRemoteAt: number | null;
  onChange: (next: string) => void;
  onDisconnect: (peerId: string) => void;
  onManage: () => void;
}

/**
 * Connected focus mode: the app gets out of the way — connected device
 * names on top, one big text field below. Everything else (pairing,
 * manual connect, settings) lives one tap away behind Manage.
 */
export function FocusView({ devices, text, peerCount, lastRemoteAt, onChange, onDisconnect, onManage }: Props) {
  return (
    <div className="flex flex-col gap-3">
      <section
        aria-label="Connected devices"
        className="flex flex-wrap items-center gap-2 rounded-2xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
      >
        <span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-500" aria-hidden="true" />
        <ul className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {devices.map((d) => (
            <li
              key={d.peerId}
              className="flex max-w-full items-center gap-1.5 rounded-full bg-zinc-100 py-1 pl-3 pr-1.5 dark:bg-zinc-800"
            >
              <span className="truncate text-xs font-medium" title={d.peerId}>
                {d.name}
              </span>
              <button
                type="button"
                onClick={() => onDisconnect(d.peerId)}
                aria-label={`Disconnect ${d.name}`}
                title={`Disconnect ${d.name}`}
                className="rounded-full px-1.5 text-xs text-zinc-400 hover:bg-zinc-200 hover:text-red-600 dark:hover:bg-zinc-700"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={onManage}
          className="shrink-0 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          Manage
        </button>
      </section>

      <SharedEditor text={text} peerCount={peerCount} lastRemoteAt={lastRemoteAt} onChange={onChange} large />
    </div>
  );
}
