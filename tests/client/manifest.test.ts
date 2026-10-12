import { describe, expect, it } from 'vitest';
import {
  buildManifest,
  chunkCountFor,
  chunkRangeForFile,
  cipherBytesFor,
  manifestMatchesInfo,
  plainChunkLength,
  readPlainChunk,
} from '../../src/client/share/manifest';
import { SHARE_CHUNK_OVERHEAD } from '../../src/shared/constants';
import { expectedChunkCipherSize, isConsistentLayout } from '../../src/shared/shareApi';

function fileOf(name: string, bytes: number[]): File {
  return new File([new Uint8Array(bytes)], name);
}

describe('share package layout', () => {
  const chunk = 4;
  const files = [
    fileOf('a', [1, 2, 3]),
    fileOf('empty', []),
    fileOf('b', [4, 5, 6, 7, 8, 9]),
    fileOf('c', [10]),
  ];
  const manifest = buildManifest(files, chunk, 0);

  it('lays files out back to back as one stream', () => {
    expect(manifest.totalBytes).toBe(10);
    expect(manifest.files.map((f) => f.offset)).toEqual([0, 3, 3, 9]);
    expect(manifest.chunkCount).toBe(3);
    expect(chunkCountFor(0, chunk)).toBe(0);
  });

  it('reads chunks that span file boundaries', async () => {
    expect([...(await readPlainChunk(files, manifest, 0))]).toEqual([1, 2, 3, 4]);
    expect([...(await readPlainChunk(files, manifest, 1))]).toEqual([5, 6, 7, 8]);
    expect([...(await readPlainChunk(files, manifest, 2))]).toEqual([9, 10]);
    expect(plainChunkLength(manifest, 2)).toBe(2);
  });

  it('maps each file to the chunks that hold it', () => {
    expect(chunkRangeForFile(manifest.files[0]!, chunk)).toEqual({ first: 0, last: 0 });
    expect(chunkRangeForFile(manifest.files[1]!, chunk)).toBeNull();
    expect(chunkRangeForFile(manifest.files[2]!, chunk)).toEqual({ first: 0, last: 2 });
    expect(chunkRangeForFile(manifest.files[3]!, chunk)).toEqual({ first: 2, last: 2 });
  });

  it('agrees with the server-side size rules', () => {
    const layout = {
      chunkBytes: chunk,
      chunkCount: manifest.chunkCount,
      cipherBytes: cipherBytesFor(manifest.totalBytes, chunk),
    };
    expect(isConsistentLayout(layout)).toBe(true);
    expect(expectedChunkCipherSize(0, layout)).toBe(chunk + SHARE_CHUNK_OVERHEAD);
    expect(expectedChunkCipherSize(2, layout)).toBe(2 + SHARE_CHUNK_OVERHEAD);
    expect(expectedChunkCipherSize(3, layout)).toBeNull();
    expect(manifestMatchesInfo(manifest, layout)).toBe(true);
    expect(manifestMatchesInfo(manifest, { ...layout, chunkCount: 4 })).toBe(false);
  });

  it('flags inconsistent layouts', () => {
    expect(isConsistentLayout({ chunkBytes: 4, chunkCount: 0, cipherBytes: 0 })).toBe(true);
    expect(isConsistentLayout({ chunkBytes: 4, chunkCount: 0, cipherBytes: 10 })).toBe(false);
    expect(
      isConsistentLayout({
        chunkBytes: 4,
        chunkCount: 2,
        cipherBytes: 2 * (4 + SHARE_CHUNK_OVERHEAD) + 1,
      }),
    ).toBe(false);
    expect(
      isConsistentLayout({
        chunkBytes: 4,
        chunkCount: 2,
        cipherBytes: 4 + SHARE_CHUNK_OVERHEAD + SHARE_CHUNK_OVERHEAD,
      }),
    ).toBe(false);
  });
});
