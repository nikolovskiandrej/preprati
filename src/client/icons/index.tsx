/**
 * preprati. icon family.
 *
 * Rules (keep these when adding icons — see docs/ICONS.md):
 * - 24×24 grid, ~2px optical padding, 1.75px stroke, round caps and joins.
 * - Geometry stays simple enough to read at 16px.
 * - One meaningful sub-part may be marked `accent`; it is painted with
 *   `--icon-accent` (tangerine in neutral contexts, current color inside
 *   buttons) — the arrow of an upload, the check of a success, the hands of a
 *   clock. Never accent the whole glyph.
 * - The Send icon is an outline of the brand plane, not a generic glyph.
 * - Icons are decorative by default (aria-hidden); pass `title` when an icon
 *   carries meaning on its own.
 */
import { forwardRef, type SVGProps } from 'react';
import './icons.css';

interface PathSpec {
  d: string;
  accent?: boolean;
}

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children' | 'ref'> {
  size?: number;
  title?: string;
}

function defineIcon(name: string, paths: PathSpec[]) {
  const Icon = forwardRef<SVGSVGElement, IconProps>(function Icon(
    { size = 20, title, className, ...rest },
    ref,
  ) {
    return (
      <svg
        ref={ref}
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className ? `icon ${className}` : 'icon'}
        aria-hidden={title ? undefined : true}
        role={title ? 'img' : undefined}
        focusable="false"
        data-icon={name}
        {...rest}
      >
        {title ? <title>{title}</title> : null}
        {paths.map((path, index) => (
          <path key={index} d={path.d} className={path.accent ? 'icon-accent' : undefined} />
        ))}
      </svg>
    );
  });
  Icon.displayName = `Icon(${name})`;
  return Icon;
}

const circle = 'M20.5 12a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0Z';
const doc = 'M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8Z';
const docFold = 'M14 3.5V8h4.5';
const tray = 'M4 14.5v3A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5v-3';

/** Eight-tooth gear outline, generated once. */
function gearPath(): string {
  const cx = 12;
  const cy = 12;
  const outer = 9;
  const inner = 7.1;
  const teeth = 8;
  const points: string[] = [];
  for (let i = 0; i < teeth; i++) {
    const base = (i / teeth) * Math.PI * 2;
    const step = (Math.PI * 2) / teeth;
    const angles = [base - step * 0.18, base - step * 0.1, base + step * 0.1, base + step * 0.18];
    const radii = [inner, outer, outer, inner];
    angles.forEach((angle, j) => {
      const r = radii[j]!;
      points.push(
        `${(cx + r * Math.cos(angle)).toFixed(2)} ${(cy + r * Math.sin(angle)).toFixed(2)}`,
      );
    });
  }
  return `M${points.join('L')}Z`;
}

export const SendIcon = defineIcon('send', [
  { d: 'M21.6 2.6 2.4 11.3l4.9 1.6 9.3-6.1-7.2 7.3 3.4 7.3Z' },
]);
export const ReceiveIcon = defineIcon('receive', [
  { d: 'M4 13.5v4A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5v-4' },
  { d: 'M4 13.5h3.8l1.4 2.2h5.6l1.4-2.2H20' },
  { d: 'M12 3.5v7.5', accent: true },
  { d: 'm8.8 8 3.2 3.2L15.2 8', accent: true },
]);
export const UploadIcon = defineIcon('upload', [
  { d: tray },
  { d: 'M12 15.5V4', accent: true },
  { d: 'M7.5 8.5 12 4l4.5 4.5', accent: true },
]);
export const DownloadIcon = defineIcon('download', [
  { d: tray },
  { d: 'M12 4v11.5', accent: true },
  { d: 'm7.5 11 4.5 4.5 4.5-4.5', accent: true },
]);
export const AddFilesIcon = defineIcon('add-files', [
  { d: doc },
  { d: docFold },
  { d: 'M12 11v6M9 14h6', accent: true },
]);
export const CloseIcon = defineIcon('close', [{ d: 'm6.5 6.5 11 11M17.5 6.5l-11 11' }]);
export const RemoveIcon = defineIcon('remove', [
  { d: circle },
  { d: 'm9.5 9.5 5 5M14.5 9.5l-5 5', accent: true },
]);
export const FolderIcon = defineIcon('folder', [
  { d: 'M3.5 7a2 2 0 0 1 2-2h3.7l2 2.2h7.3a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z' },
  { d: 'M3.5 10.2h17', accent: true },
]);
export const DocumentIcon = defineIcon('document', [
  { d: doc },
  { d: docFold },
  { d: 'M9 12.5h6M9 16h4', accent: true },
]);
export const ImageIcon = defineIcon('image', [
  { d: 'M4 6.5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z' },
  { d: 'm4.5 17 4.5-4.5 3.5 3.5 2-2 5 5' },
  { d: 'M17.25 9a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 0 1 3.5 0Z', accent: true },
]);
export const VideoIcon = defineIcon('video', [
  { d: 'M3.5 7.5a2 2 0 0 1 2-2H14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2Z' },
  { d: 'm16 10.2 4.5-2.7v9L16 13.8', accent: true },
]);
export const AudioIcon = defineIcon('audio', [
  { d: 'M9 17.5V5.8L19 4v11.7' },
  {
    d: 'M9 17.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0ZM19 15.7a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z',
  },
  { d: 'M9 9.4 19 7.6', accent: true },
]);
export const ArchiveIcon = defineIcon('archive', [
  { d: doc },
  { d: 'M11 3.5V5M13 6.5V8M11 9.5V11M13 12.5V14', accent: true },
  { d: 'M10.5 15.5h3v3h-3Z' },
]);
export const QrIcon = defineIcon('qr', [
  { d: 'M4 4h6v6H4ZM14 4h6v6h-6ZM4 14h6v6H4Z' },
  { d: 'M14 14h2.5v2.5H14ZM20 14v.01M20 20h-2.5M14 20v.01M17.5 17.5v.01', accent: true },
]);
export const CopyQrIcon = defineIcon('copy-qr', [
  { d: 'M8 8V5.5A1.5 1.5 0 0 1 9.5 4h9A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H16' },
  {
    d: 'M4 9.5A1.5 1.5 0 0 1 5.5 8h9A1.5 1.5 0 0 1 16 9.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 18.5Z',
  },
  { d: 'M7 11.2h2.6v2.6H7ZM12.6 11.2v.01M7 17v.01M12.6 15.4V17H11', accent: true },
]);
export const DownloadQrIcon = defineIcon('download-qr', [
  { d: 'M4 4h5v5H4ZM15 4h5v5h-5ZM4 15h5v5H4Z' },
  { d: 'M17.5 12v8.5', accent: true },
  { d: 'm14.5 17.5 3 3 3-3', accent: true },
]);
export const LinkIcon = defineIcon('link', [
  { d: 'M10.2 13.8a4 4 0 0 0 5.66 0l2.82-2.82a4 4 0 1 0-5.66-5.66l-1.2 1.2' },
  { d: 'M13.8 10.2a4 4 0 0 0-5.66 0l-2.82 2.82a4 4 0 1 0 5.66 5.66l1.2-1.2', accent: true },
]);
export const CopyIcon = defineIcon('copy', [
  { d: 'M8.5 8.5V6a2 2 0 0 1 2-2H18a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-2.5' },
  { d: 'M4 10.5a2 2 0 0 1 2-2h7.5a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z' },
]);
export const ShareIcon = defineIcon('share', [
  { d: 'M8 10H6.5a2 2 0 0 0-2 2v6.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V12a2 2 0 0 0-2-2H16' },
  { d: 'M12 3.5V14M8.5 7 12 3.5 15.5 7', accent: true },
]);
export const DevicesIcon = defineIcon('devices', [
  { d: 'M4.5 15V7a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1.5M2.5 18.5h11' },
  {
    d: 'M17.5 11h2a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-2a1.5 1.5 0 0 1-1.5-1.5v-6a1.5 1.5 0 0 1 1.5-1.5Z',
    accent: true,
  },
]);
export const PhoneIcon = defineIcon('phone', [
  {
    d: 'M8 3.5h8a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 19V5A1.5 1.5 0 0 1 8 3.5Z',
  },
  { d: 'M11 17.5h2', accent: true },
]);
export const LaptopIcon = defineIcon('laptop', [
  { d: 'M5 15V6.5A1.5 1.5 0 0 1 6.5 5h11A1.5 1.5 0 0 1 19 6.5V15' },
  { d: 'M2.5 18.5h19', accent: true },
]);
export const ConnectionIcon = defineIcon('connection', [
  { d: 'M3 9.5a13 13 0 0 1 18 0M6 12.8a8.5 8.5 0 0 1 12 0' },
  { d: 'M9 16a4.2 4.2 0 0 1 6 0M12 19.3v.01', accent: true },
]);
export const RelayIcon = defineIcon('relay', [
  {
    d: 'M4.5 5.5A1.5 1.5 0 0 1 6 4h12a1.5 1.5 0 0 1 1.5 1.5v3A1.5 1.5 0 0 1 18 10H6a1.5 1.5 0 0 1-1.5-1.5ZM4.5 15.5A1.5 1.5 0 0 1 6 14h12a1.5 1.5 0 0 1 1.5 1.5v3A1.5 1.5 0 0 1 18 20H6a1.5 1.5 0 0 1-1.5-1.5Z',
  },
  { d: 'M7.5 7v.01M7.5 17v.01', accent: true },
]);
export const ShieldIcon = defineIcon('security', [
  { d: 'M12 3.5 5 6.2v5.1c0 4.2 2.9 8 7 9.2 4.1-1.2 7-5 7-9.2V6.2Z' },
  { d: 'm9 12 2.1 2.1 4.1-4.2', accent: true },
]);
export const LockIcon = defineIcon('lock', [
  { d: 'M7.5 10.5V8a4.5 4.5 0 0 1 9 0v2.5' },
  {
    d: 'M5.5 12A1.5 1.5 0 0 1 7 10.5h10a1.5 1.5 0 0 1 1.5 1.5v6.5A1.5 1.5 0 0 1 17 20H7a1.5 1.5 0 0 1-1.5-1.5Z',
  },
  { d: 'M12 14.2v2.3', accent: true },
]);
export const ProgressIcon = defineIcon('progress', [
  { d: 'M4.5 16a7.5 7.5 0 1 1 15 0' },
  { d: 'm12 16 3.6-4.2', accent: true },
]);
export const CheckCircleIcon = defineIcon('completed', [
  { d: circle },
  { d: 'm8.4 12.3 2.4 2.4 4.8-5', accent: true },
]);
export const CheckIcon = defineIcon('check', [{ d: 'm5 12.5 4.5 4.5L19 7.5' }]);
export const ErrorIcon = defineIcon('error', [
  { d: circle },
  { d: 'M12 7.8v5M12 16.2v.01', accent: true },
]);
export const RetryIcon = defineIcon('retry', [
  { d: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3' },
  { d: 'M19.5 4.5v4h-4', accent: true },
]);
export const CancelIcon = defineIcon('cancel', [{ d: circle }, { d: 'm6 6 12 12', accent: true }]);
export const SettingsIcon = defineIcon('settings', [
  { d: gearPath() },
  { d: 'M14.5 12a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z', accent: true },
]);
export const ClockIcon = defineIcon('clock', [
  { d: circle },
  { d: 'M12 7.5V12l3 2', accent: true },
]);
export const ExpireIcon = defineIcon('expiration', [
  { d: 'M7 3.5h10M7 20.5h10' },
  {
    d: 'M8 3.5v3.2a4 4 0 0 0 1.6 3.2L12 12l2.4-2.1A4 4 0 0 0 16 6.7V3.5M8 20.5v-3.2a4 4 0 0 1 1.6-3.2L12 12l2.4 2.1a4 4 0 0 1 1.6 3.2v3.2',
  },
  { d: 'M10 18.5h4', accent: true },
]);
export const TrashIcon = defineIcon('delete-share', [
  { d: 'M4.5 7h15M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7' },
  { d: 'M6.5 7l.75 11.15A2 2 0 0 0 9.25 20h5.5a2 2 0 0 0 2-1.85L17.5 7' },
  { d: 'M10 11v5M14 11v5', accent: true },
]);
export const ArrowLeftIcon = defineIcon('arrow-left', [{ d: 'M19 12H5M11 6l-6 6 6 6' }]);
export const ArrowRightIcon = defineIcon('arrow-right', [{ d: 'M5 12h14M13 6l6 6-6 6' }]);
export const ChevronDownIcon = defineIcon('chevron-down', [{ d: 'm6.5 9.5 5.5 5.5 5.5-5.5' }]);
export const SunIcon = defineIcon('sun', [
  { d: 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z' },
  {
    d: 'M12 2.8v1.6M12 19.6v1.6M2.8 12h1.6M19.6 12h1.6M5.5 5.5l1.1 1.1M17.4 17.4l1.1 1.1M5.5 18.5l1.1-1.1M17.4 6.6l1.1-1.1',
    accent: true,
  },
]);
export const MoonIcon = defineIcon('moon', [
  { d: 'M19.8 14.6A8 8 0 0 1 9.4 4.2a8 8 0 1 0 10.4 10.4Z' },
]);
export const GlobeIcon = defineIcon('globe', [
  { d: circle },
  {
    d: 'M3.5 12h17M12 3.5c2.4 2.6 3.5 5.4 3.5 8.5s-1.1 5.9-3.5 8.5c-2.4-2.6-3.5-5.4-3.5-8.5s1.1-5.9 3.5-8.5Z',
    accent: true,
  },
]);
export const InfoIcon = defineIcon('info', [
  { d: circle },
  { d: 'M12 11v5M12 7.8v.01', accent: true },
]);

/** Registry used by the icon gallery (dev only) and docs. */
export const ICONS = {
  send: SendIcon,
  receive: ReceiveIcon,
  upload: UploadIcon,
  download: DownloadIcon,
  'add-files': AddFilesIcon,
  remove: RemoveIcon,
  close: CloseIcon,
  folder: FolderIcon,
  document: DocumentIcon,
  image: ImageIcon,
  video: VideoIcon,
  audio: AudioIcon,
  archive: ArchiveIcon,
  qr: QrIcon,
  'copy-qr': CopyQrIcon,
  'download-qr': DownloadQrIcon,
  link: LinkIcon,
  copy: CopyIcon,
  share: ShareIcon,
  devices: DevicesIcon,
  phone: PhoneIcon,
  laptop: LaptopIcon,
  connection: ConnectionIcon,
  relay: RelayIcon,
  security: ShieldIcon,
  lock: LockIcon,
  progress: ProgressIcon,
  completed: CheckCircleIcon,
  check: CheckIcon,
  error: ErrorIcon,
  retry: RetryIcon,
  cancel: CancelIcon,
  settings: SettingsIcon,
  clock: ClockIcon,
  expiration: ExpireIcon,
  'delete-share': TrashIcon,
  'arrow-left': ArrowLeftIcon,
  'arrow-right': ArrowRightIcon,
  'chevron-down': ChevronDownIcon,
  sun: SunIcon,
  moon: MoonIcon,
  globe: GlobeIcon,
  info: InfoIcon,
} as const;

export type IconName = keyof typeof ICONS;
export type IconComponent = (typeof ICONS)[IconName];
