/**
 * File selection: a real <input type="file" multiple> behind a button, with
 * drag-and-drop as an optional extra on devices that support it.
 */
import { useId, useRef, useState, type DragEvent } from 'react';
import { AddFilesIcon, UploadIcon } from '../icons';
import { useI18n } from '../i18n';
import { Button, type ButtonVariant } from './Button';
import styles from './FilePicker.module.css';

export function FilePicker({
  onFiles,
  compact = false,
  disabled = false,
  buttonVariant = 'dark',
  surface = 'light',
}: {
  onFiles: (files: File[]) => void;
  /** Show only an "Add files" button (files already selected). */
  compact?: boolean;
  disabled?: boolean;
  buttonVariant?: ButtonVariant;
  surface?: 'light' | 'dark';
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  const open = () => inputRef.current?.click();

  const accept = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const files = [...list].filter((file) => file.size >= 0);
    if (files.length > 0) onFiles(files);
  };

  const onDragEnter = (event: DragEvent) => {
    if (disabled || ![...event.dataTransfer.types].includes('Files')) return;
    event.preventDefault();
    depth.current += 1;
    setDragging(true);
  };
  const onDragOver = (event: DragEvent) => {
    if (disabled || ![...event.dataTransfer.types].includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = () => {
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  };
  const onDrop = (event: DragEvent) => {
    if (disabled) return;
    event.preventDefault();
    depth.current = 0;
    setDragging(false);
    accept(event.dataTransfer.files);
  };

  const input = (
    <input
      ref={inputRef}
      id={inputId}
      type="file"
      multiple
      className="visually-hidden"
      tabIndex={-1}
      disabled={disabled}
      aria-hidden="true"
      onChange={(event) => {
        accept(event.currentTarget.files);
        event.currentTarget.value = '';
      }}
    />
  );

  if (compact) {
    return (
      <div
        className={`${styles.compact} ${dragging ? styles.dragging : ''}`}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {input}
        <Button variant="ghost" size="sm" icon={AddFilesIcon} onClick={open} disabled={disabled}>
          {t('files.chooseMore')}
        </Button>
        <span className={styles.compactHint} aria-hidden="true">
          {dragging ? t('files.dropActive') : null}
        </span>
      </div>
    );
  }

  return (
    <div
      className={`${styles.zone} ${surface === 'dark' ? styles.onDark : ''} ${dragging ? styles.dragging : ''}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      data-testid="file-dropzone"
    >
      {input}
      <span className={styles.glyph} aria-hidden="true">
        <UploadIcon size={28} />
      </span>
      <p className={styles.title} aria-hidden="true">
        {dragging ? t('files.dropActive') : t('files.dropTitle')}
      </p>
      <p className={styles.or} aria-hidden="true">
        {t('files.dropOr')}
      </p>
      <Button
        variant={buttonVariant}
        icon={AddFilesIcon}
        onClick={open}
        disabled={disabled}
        size="lg"
      >
        {t('files.choose')}
      </Button>
    </div>
  );
}
