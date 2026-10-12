import { useId, useState, type FormEvent } from 'react';
import { useLocation } from 'wouter';
import { normalizePairingCode, PAIRING_CODE_PATTERN } from '../../shared/constants';
import { FlowHeader } from '../features/common/FlowHeader';
import { useI18n } from '../i18n';
import { ConnectionIcon } from '../icons';
import { Button } from '../ui/Button';
import styles from './QuickScreens.module.css';

/** Manual pairing: type the code shown on the other device. */
export default function JoinCodeScreen() {
  const { t } = useI18n();
  const [, navigate] = useLocation();
  const [code, setCode] = useState('');
  const [invalid, setInvalid] = useState(false);
  const inputId = useId();
  const errorId = useId();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const normalized = normalizePairingCode(code);
    if (!PAIRING_CODE_PATTERN.test(normalized)) {
      setInvalid(true);
      return;
    }
    navigate(`/j/${normalized}`);
  };

  return (
    <div className={styles.single}>
      <FlowHeader title={t('join.title')} lead={t('join.lead')} mode="quick" />
      <form className={styles.codeCard} onSubmit={submit} noValidate>
        <label htmlFor={inputId} className="visually-hidden">
          {t('home.quick.codeLabel')}
        </label>
        <input
          id={inputId}
          className={styles.codeInput}
          value={code}
          onChange={(event) => {
            setCode(event.target.value);
            setInvalid(false);
          }}
          placeholder={t('home.quick.codePlaceholder')}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={12}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
        />
        {invalid ? (
          <p id={errorId} className={styles.fieldError} role="alert">
            {t('home.quick.codeInvalid')}
          </p>
        ) : null}
        <Button type="submit" variant="primary" size="lg" icon={ConnectionIcon}>
          {t('join.submit')}
        </Button>
      </form>
    </div>
  );
}
