/**
 * One file in a list: type icon, name (extension always visible), size and a
 * status/action slot. Names are rendered as text — never as HTML.
 */
import type { ReactNode } from 'react';
import {
  ArchiveIcon,
  AudioIcon,
  DocumentIcon,
  FolderIcon,
  ImageIcon,
  VideoIcon,
  type IconProps,
} from '../icons';
import { fileKind, type FileKind } from '../lib/files';
import styles from './FileRow.module.css';

const KIND_ICONS: Record<FileKind, (props: IconProps) => ReactNode> = {
  image: ImageIcon,
  video: VideoIcon,
  audio: AudioIcon,
  archive: ArchiveIcon,
  document: DocumentIcon,
  file: FolderIcon,
};

export function FileKindIcon({
  name,
  type,
  size = 22,
}: {
  name: string;
  type: string;
  size?: number;
}) {
  const Icon = KIND_ICONS[fileKind(name, type)];
  return <Icon size={size} />;
}

export function splitName(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || name.length - dot > 12) return { base: name, ext: '' };
  return { base: name.slice(0, dot), ext: name.slice(dot) };
}

export function FileRow({
  name,
  type,
  meta,
  action,
  progress,
  tone = 'light',
}: {
  name: string;
  type: string;
  meta: ReactNode;
  action?: ReactNode;
  progress?: ReactNode;
  tone?: 'light' | 'dark';
}) {
  const { base, ext } = splitName(name);
  return (
    <li className={`${styles.row} ${tone === 'dark' ? styles.dark : ''}`}>
      <span className={styles.icon} aria-hidden="true">
        <FileKindIcon name={name} type={type} />
      </span>
      <div className={styles.text}>
        <p className={styles.name} title={name}>
          <span className={styles.base}>{base}</span>
          {ext ? <span className={styles.ext}>{ext}</span> : null}
        </p>
        <p className={styles.meta}>{meta}</p>
        {progress ? <div className={styles.progress}>{progress}</div> : null}
      </div>
      {action ? <div className={styles.action}>{action}</div> : null}
    </li>
  );
}

export function FileListFrame({ children, label }: { children: ReactNode; label: string }) {
  return (
    <ul className={styles.list} aria-label={label}>
      {children}
    </ul>
  );
}
