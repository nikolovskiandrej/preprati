// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { SelectedFilesPane } from '../../src/client/features/common/SelectedFilesPane';
import { localFileId, type SelectedFile } from '../../src/client/lib/files';
import { renderWithProviders } from './render';

function Harness({ maxFileBytes }: { maxFileBytes?: number }) {
  const [files, setFiles] = useState<SelectedFile[]>([]);
  return (
    <SelectedFilesPane
      title="Your files"
      files={files}
      maxFileBytes={maxFileBytes}
      onAdd={(added) =>
        setFiles((current) => [...current, ...added.map((file) => ({ id: localFileId(), file }))])
      }
      onRemove={(id) => setFiles((current) => current.filter((entry) => entry.id !== id))}
    />
  );
}

describe('file selection', () => {
  it('lists chosen files with sizes and a total, and lets you remove them', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<Harness />);
    const input = container.querySelector('input[type=file]') as HTMLInputElement;
    expect(screen.getByRole('button', { name: 'Choose files' })).toBeInTheDocument();

    await user.upload(input, [
      new File([new Uint8Array(12_400_000)], 'Homework.pdf', { type: 'application/pdf' }),
      new File(['hi'], '<script>alert(1)</script>.txt', { type: 'text/plain' }),
    ]);
    expect(screen.getByText('2 files selected · Total 12.4 MB')).toBeInTheDocument();
    expect(screen.getByText('Homework')).toBeInTheDocument();
    expect(screen.getByText('12.4 MB')).toBeInTheDocument();
    // File names are text, never markup.
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove Homework.pdf' }));
    expect(screen.queryByText('Homework')).not.toBeInTheDocument();
    expect(screen.getByText('1 file selected · Total 2 B')).toBeInTheDocument();
  });

  it('flags files above the configured limit', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<Harness maxFileBytes={1000} />);
    await user.upload(
      container.querySelector('input[type=file]') as HTMLInputElement,
      new File([new Uint8Array(5000)], 'big.bin'),
    );
    expect(screen.getByText(/Larger than 1,000 B|Larger than 1 KB/)).toBeInTheDocument();
  });
});
