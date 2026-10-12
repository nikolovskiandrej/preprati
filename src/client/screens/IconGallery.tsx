/**
 * Development-only icon gallery (/_dev/icons). Not included in production
 * builds. Shows every icon at 16/20/24px on light, charcoal and peach
 * surfaces so new icons can be checked against the family rules.
 */
import { ICONS } from '../icons';
import styles from './IconGallery.module.css';

export default function IconGallery() {
  return (
    <div className={styles.page}>
      <h1>Icon family</h1>
      <p>24px grid · 1.75 stroke · round joins · one accent part per glyph.</p>
      {(['light', 'dark', 'peach'] as const).map((surface) => (
        <section key={surface} className={`${styles.surface} ${styles[surface]}`}>
          {Object.entries(ICONS).map(([name, Icon]) => (
            <figure key={name} className={styles.item}>
              <div className={styles.sizes}>
                <Icon size={16} />
                <Icon size={20} />
                <Icon size={24} />
                <Icon size={40} />
              </div>
              <figcaption>{name}</figcaption>
            </figure>
          ))}
        </section>
      ))}
    </div>
  );
}
