import { AnimatePresence, LazyMotion, MotionConfig, domMax, m } from 'motion/react';
import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Route, Switch, useLocation } from 'wouter';
import { IntroSplash, shouldPlayIntro } from '../brand/IntroSplash';
import { I18nProvider, useI18n } from '../i18n';
import { HomeScreen } from '../screens/HomeScreen';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { ToastProvider } from '../ui/Toast';
import { AppShell } from './AppShell';
import { ConfigProvider } from './config';
import { ThemeProvider } from './theme';
import styles from './App.module.css';

const SendScreen = lazy(() => import('../screens/SendScreen'));
const ReceiveScreen = lazy(() => import('../screens/ReceiveScreen'));
const JoinScreen = lazy(() => import('../screens/JoinScreen'));
const JoinCodeScreen = lazy(() => import('../screens/JoinCodeScreen'));
const ShareScreen = lazy(() => import('../screens/ShareScreen'));
const RecipientScreen = lazy(() => import('../screens/RecipientScreen'));
const NotFoundScreen = lazy(() => import('../screens/NotFoundScreen'));
const IconGallery = import.meta.env.DEV ? lazy(() => import('../screens/IconGallery')) : null;

/** Decided once per page load (the check records that the intro was seen). */
const PLAY_INTRO = typeof window !== 'undefined' && shouldPlayIntro(window.location);

export function App() {
  return (
    <LazyMotion features={domMax} strict>
      <MotionConfig reducedMotion="user">
        <I18nProvider>
          <ThemeProvider>
            <ConfigProvider>
              <ToastProvider>
                <Routes />
              </ToastProvider>
            </ConfigProvider>
          </ThemeProvider>
        </I18nProvider>
      </MotionConfig>
    </LazyMotion>
  );
}

function Routes() {
  const [location] = useLocation();
  const [introActive, setIntroActive] = useState(PLAY_INTRO);
  const finishIntro = useCallback(() => setIntroActive(false), []);
  const firstRender = useRef(true);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    // New screen: start at the top and move focus to the main region for assistive tech.
    window.scrollTo(0, 0);
    document.getElementById('main')?.focus({ preventScroll: true });
  }, [location]);

  return (
    <>
      <AnimatePresence>
        {introActive ? <IntroSplash key="intro" onComplete={finishIntro} /> : null}
      </AnimatePresence>
      <AppShell introActive={introActive}>
        <ErrorBoundary>
          <Suspense fallback={<ScreenFallback />}>
            <AnimatePresence mode="wait" initial={false}>
              <m.div
                key={location}
                className={styles.screen}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: { duration: 0.1 } }}
                transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
              >
                <Switch location={location}>
                  <Route path="/">
                    <HomeScreen introActive={introActive} />
                  </Route>
                  <Route path="/send" component={SendScreen} />
                  <Route path="/receive" component={ReceiveScreen} />
                  <Route path="/join" component={JoinCodeScreen} />
                  <Route path="/j/:token" component={JoinScreen} />
                  <Route path="/share" component={ShareScreen} />
                  <Route path="/s/:id" component={RecipientScreen} />
                  {IconGallery ? <Route path="/_dev/icons" component={IconGallery} /> : null}
                  <Route component={NotFoundScreen} />
                </Switch>
              </m.div>
            </AnimatePresence>
          </Suspense>
        </ErrorBoundary>
      </AppShell>
    </>
  );
}

function ScreenFallback() {
  return (
    <div className={styles.fallback}>
      <Spinner size={22} />
    </div>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    console.error(error);
  }

  override render() {
    return this.state.failed ? <CrashScreen /> : this.props.children;
  }
}

function CrashScreen() {
  const { t } = useI18n();
  return (
    <div className={styles.crash} role="alert">
      <h1>{t('errors.title')}</h1>
      <p>{t('errors.internal')}</p>
      <Button variant="dark" onClick={() => window.location.reload()}>
        {t('common.retry')}
      </Button>
    </div>
  );
}
