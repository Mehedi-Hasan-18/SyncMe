import { useEffect, useState } from 'react';

export type Route = { name: 'main' } | { name: 'pair'; ws: string; token: string };

/** Minimal hash router (no dependency, works on static hosts with no rewrites). */
export function parseHash(hash: string): Route {
  if (!hash.startsWith('#/pair')) return { name: 'main' };
  const queryIndex = hash.indexOf('?');
  const params = new URLSearchParams(queryIndex >= 0 ? hash.slice(queryIndex + 1) : '');
  const ws = params.get('ws') ?? '';
  const token = params.get('token') ?? '';
  if (!ws || !token) return { name: 'main' };
  return { name: 'pair', ws, token };
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() =>
    typeof window === 'undefined' ? { name: 'main' } : parseHash(window.location.hash),
  );

  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return route;
}

export function navigateMain(): void {
  window.location.hash = '#/';
}
