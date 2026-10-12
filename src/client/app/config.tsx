/**
 * Runtime configuration from the server (limits, expiry, availability,
 * attribution link). Fetched once per page load.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { PublicConfig } from '../../shared/shareApi';
import { loadPublicConfig } from '../lib/runtimeConfig';

interface ConfigContextValue {
  config: PublicConfig | null;
  status: 'loading' | 'ready' | 'error';
  reload: () => void;
}

const ConfigContext = createContext<ConfigContextValue | null>(null);

export function ConfigProvider({
  children,
  initial,
}: {
  children: ReactNode;
  initial?: PublicConfig;
}) {
  const [config, setConfig] = useState<PublicConfig | null>(initial ?? null);
  const [status, setStatus] = useState<ConfigContextValue['status']>(initial ? 'ready' : 'loading');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (initial) return;
    let active = true;
    loadPublicConfig()
      .then((value) => {
        if (!active) return;
        setConfig(value);
        setStatus('ready');
      })
      .catch(() => {
        if (active) setStatus('error');
      });
    return () => {
      active = false;
    };
  }, [attempt, initial]);

  const reload = useCallback(() => {
    setStatus('loading');
    setAttempt((value) => value + 1);
  }, []);
  const value = useMemo(() => ({ config, status, reload }), [config, status, reload]);
  return <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>;
}

export function useConfig(): ConfigContextValue {
  const value = useContext(ConfigContext);
  if (!value) throw new Error('useConfig must be used inside <ConfigProvider>');
  return value;
}
