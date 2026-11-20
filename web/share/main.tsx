import { createRoot } from 'react-dom/client';
import '../src/fonts';
import '../src/house-tokens.css';
import '../src/styles.css';
import type { ShareIndexEntry, ShareSnapshot } from '../../shared/types';
import { ShareIndex, ShareView } from '../src/ShareView';

// The Pages functions put the data into the page: one note's snapshot at /s/<id>, the list at /.
function inlined<T>(id: string): T | null {
  const el = document.getElementById(id);
  if (!el?.textContent) return null;
  try {
    return JSON.parse(el.textContent);
  } catch {
    return null;
  }
}

const index = inlined<ShareIndexEntry[]>('share-index');
createRoot(document.getElementById('root')!).render(index ? <ShareIndex items={index} /> : <ShareView snap={inlined<ShareSnapshot>('snapshot')} />);
