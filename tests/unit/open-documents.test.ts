import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DocumentOpener, documentArgs, documentKind } from '../../src/main/open-documents';

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe('documents from the file manager (plan D9)', () => {
  it('tells packs from project folders', () => {
    expect(documentKind('/a/Lesson.cstudiopack')).toBe('pack');
    expect(documentKind('C:\\x\\Lesson.ZIP')).toBe('pack');
    expect(documentKind('/a/Lesson.cstudio/')).toBe('project');
    expect(documentKind('/a/notes.txt')).toBeNull();
  });

  it('finds documents among launch arguments, never switches or zips', () => {
    expect(
      documentArgs(
        [
          '--action',
          'new-recording',
          'Lesson.cstudiopack',
          '/p/A.cstudio',
          'b.zip',
          '--x=y.cstudio',
        ],
        '/home/u',
      ),
    ).toEqual([path.resolve('/home/u', 'Lesson.cstudiopack'), path.resolve('/p/A.cstudio')]);
  });

  it('queues until ready, then opens each in turn, and reports failures', async () => {
    const opened: string[] = [];
    const showError = vi.fn();
    const opener = new DocumentOpener({
      unpack: (file) =>
        file.includes('bad')
          ? Promise.reject(new Error('it is not a zip archive'))
          : Promise.resolve({ id: `prj_${path.basename(file, '.cstudiopack')}` }),
      importFolder: () => Promise.resolve({ id: 'prj_folder' }),
      openEditor: (id) => opened.push(id),
      showError,
      logger,
    });
    opener.open(['/d/One.cstudiopack', '/d/bad.cstudiopack']);
    await opener.idle();
    expect(opened).toEqual([]);
    opener.ready();
    opener.open(['/d/Two.cstudio']);
    await opener.idle();
    expect(opened).toEqual(['prj_One', 'prj_folder']);
    expect(showError).toHaveBeenCalledWith(
      'The pack could not be opened',
      'bad.cstudiopack: it is not a zip archive',
    );
  });
});
