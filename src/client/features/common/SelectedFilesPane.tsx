import { useId, type ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { CloseIcon } from '../../icons';
import { totalSize, type SelectedFile } from '../../lib/files';
import { formatBytes } from '../../lib/format';
import { FileListFrame, FileRow } from '../../ui/FileRow';
import { FilePicker } from '../../ui/FilePicker';
import styles from './SelectedFilesPane.module.css';

/** The sender's file selection: picker, list with sizes, removal and totals. */
export function SelectedFilesPane({
  title,
  files,
  onAdd,
  onRemove,
  locked = false,
  maxFileBytes,
  children,
}: {
  title: string;
  files: SelectedFile[];
  onAdd: (files: File[]) => void;
  onRemove: (id: string) => void;
  locked?: boolean;
  maxFileBytes?: number;
  children?: ReactNode;
}) {
  const { t, locale } = useI18n();
  const headingId = useId();
  const total = totalSize(files.map((entry) => entry.file));

  return (
    <section className={styles.pane} aria-labelledby={headingId}>
      <div className={styles.head}>
        <h2 id={headingId} className={styles.title}>
          {title}
        </h2>
        {files.length > 0 ? (
          <p className={styles.summary} aria-live="polite">
            {t('files.selected', { count: files.length })} ·{' '}
            {t('files.total', { size: formatBytes(total, locale) })}
          </p>
        ) : null}
      </div>

      {files.length === 0 ? (
        <FilePicker onFiles={onAdd} disabled={locked} />
      ) : (
        <>
          <div className={styles.list}>
            <FileListFrame label={title}>
              {files.map(({ id, file }) => {
                const tooLarge = maxFileBytes !== undefined && file.size > maxFileBytes;
                return (
                  <FileRow
                    key={id}
                    name={file.name}
                    type={file.type}
                    meta={
                      tooLarge ? (
                        <span className={styles.problem}>
                          {formatBytes(file.size, locale)} ·{' '}
                          {t('files.tooLarge', { limit: formatBytes(maxFileBytes, locale) })}
                        </span>
                      ) : file.size === 0 ? (
                        t('files.emptyFile')
                      ) : (
                        formatBytes(file.size, locale)
                      )
                    }
                    action={
                      locked ? null : (
                        <button
                          type="button"
                          className={styles.remove}
                          onClick={() => onRemove(id)}
                          aria-label={t('files.remove', { name: file.name })}
                        >
                          <CloseIcon size={18} />
                        </button>
                      )
                    }
                  />
                );
              })}
            </FileListFrame>
          </div>
          {!locked ? <FilePicker compact onFiles={onAdd} /> : null}
        </>
      )}
      {children}
    </section>
  );
}
