import { describe, expect, it, vi } from 'vitest';
import {
  applyOperations, findCompactableFiles, mergeDeviceDocuments, nextStamp, parseDeviceDocument, STALE_DEVICE_FILE_MS,
} from './document.js';

describe('parseDeviceDocument', () => {
  it('keeps valid entries and drops malformed ones', () => {
    const parsed = parseDeviceDocument({
      version: 1,
      device: 'd1',
      profile: { labels: { value: [], at: 1 }, broken: { at: 'x' } },
      collections: { tasks: { 1: { item: { id: 1 }, at: 5 }, 2: { item: 'text', at: 5 }, 3: { item: null, at: 6 } } },
    });

    expect(parsed).toEqual({
      version: 1,
      device: 'd1',
      profile: { labels: { value: [], at: 1 } },
      collections: { tasks: { 1: { item: { id: 1 }, at: 5 }, 3: { item: null, at: 6 } } },
    });
  });

  it.each([
    ['null', null, 'corrupt-file'],
    ['an array', [], 'corrupt-file'],
    ['a file with no device id', { version: 1 }, 'corrupt-file'],
    ['a newer format', { version: 2, device: 'd1' }, 'unsupported-version'],
  ])('refuses %s instead of treating it as empty', (_name, raw, code) => {
    expect(() => parseDeviceDocument(raw)).toThrow(expect.objectContaining({ code }));
  });
});

describe('applyOperations', () => {
  it('stamps upserts, deletes and profile fields with the write time without touching the input', () => {
    const base = parseDeviceDocument({ version: 1, device: 'd1', collections: { tasks: { 1: { item: { id: 1 }, at: 1 } } } });

    const next = applyOperations(base, [
      { type: 'upsert', collection: 'tasks', item: { id: 2 } },
      { type: 'delete', collection: 'tasks', id: 1 },
      { type: 'profile', data: { appMode: 'tasks' } },
    ], 50);

    expect(next).toEqual({
      version: 1,
      device: 'd1',
      profile: { appMode: { value: 'tasks', at: 50 } },
      collections: { tasks: { 1: { item: null, at: 50 }, 2: { item: { id: 2 }, at: 50 } } },
    });
    expect(base.collections.tasks[1].item).toEqual({ id: 1 });
  });
});

describe('mergeDeviceDocuments', () => {
  it('keeps the newest version of each record and field across devices', () => {
    const doc = (device, tasks, profile = {}) => parseDeviceDocument({ version: 1, device, profile, collections: { tasks } });
    const cases = [
      ['newer edit wins', [doc('a', { 1: { item: { id: 1, v: 'old' }, at: 1 } }), doc('b', { 1: { item: { id: 1, v: 'new' }, at: 2 } })], [{ id: 1, v: 'new' }]],
      ['newer delete hides an older copy', [doc('a', { 1: { item: { id: 1 }, at: 1 } }), doc('b', { 1: { item: null, at: 2 } })], []],
      ['older delete loses to a newer edit', [doc('a', { 1: { item: { id: 1 }, at: 3 } }), doc('b', { 1: { item: null, at: 2 } })], [{ id: 1 }]],
      ['a tie goes to the higher device id', [doc('b', { 1: { item: { id: 1, v: 'b' }, at: 1 } }), doc('a', { 1: { item: { id: 1, v: 'a' }, at: 1 } })], [{ id: 1, v: 'b' }]],
      ['records only one device has are kept', [doc('a', { 1: { item: { id: 1 }, at: 1 } }), doc('b', { 2: { item: { id: 2 }, at: 1 } })], [{ id: 1 }, { id: 2 }]],
    ];

    for (const [name, docs, expected] of cases) {
      expect(mergeDeviceDocuments(docs).collections.tasks, name).toEqual(expected);
    }
  });

  it('reports the ids whose newest entry is a delete', () => {
    const doc = (device, tasks) => parseDeviceDocument({ version: 1, device, collections: { tasks } });

    const { deleted } = mergeDeviceDocuments([
      doc('a', { 1: { item: { id: 1 }, at: 1 }, 2: { item: { id: 2 }, at: 5 } }),
      doc('b', { 1: { item: null, at: 2 }, 2: { item: null, at: 4 } }),
    ]);

    expect(deleted).toEqual({ tasks: ['1'] });
  });
});

describe('nextStamp', () => {
  it.each([
    ['the clock is ahead of everything seen', 100, 50, 100],
    ['another device wrote with a clock running ahead', 100, 500, 501],
    ['a write landed in the same millisecond', 100, 100, 101],
  ])('stamps after %s', (_name, now, latestSeen, expected) => {
    expect(nextStamp(now, latestSeen)).toBe(expected);
  });
});

describe('findCompactableFiles', () => {
  const NOW_MS = 1_700_000_000_000;
  const old = new Date(NOW_MS - STALE_DEVICE_FILE_MS - 1).toISOString();
  const recent = new Date(NOW_MS).toISOString();
  const doc = (device, tasks) => ({ version: 1, device, profile: {}, collections: { tasks } });
  const entry = (at, name = 'x') => ({ item: { id: 1, name }, at });
  const options = { now: NOW_MS, isOwn: () => false };

  it('lists only files that are idle, not needed and not this device\'s own', () => {
    const entries = [
      { id: 'a', name: 'kandone-a.json', modifiedTime: old, document: doc('a', { 1: entry(5) }) },
      { id: 'b', name: 'kandone-b.json', modifiedTime: recent, document: doc('b', { 1: entry(9) }) },
      { id: 'c', name: 'kandone-c.json', modifiedTime: old, document: doc('c', { 1: entry(2) }) },
    ];

    const ids = findCompactableFiles(entries, { ...options, isOwn: (f) => f.id === 'c' }).map((f) => f.id);

    expect(ids).toEqual(['a']);
  });

  it('asks whether a file is its own only once it is otherwise deletable', () => {
    const isOwn = vi.fn(() => false);
    const entries = [
      { id: 'a', name: 'kandone-a.json', modifiedTime: old, document: doc('a', { 1: entry(9) }) },
    ];

    findCompactableFiles(entries, { ...options, isOwn });

    expect(isOwn).not.toHaveBeenCalled();
  });

  it('measures idleness against the newest write Drive reports when the local clock is ahead of it', () => {
    const entries = [
      { id: 'a', name: 'kandone-a.json', modifiedTime: old, document: doc('a', { 1: entry(5) }) },
      { id: 'b', name: 'kandone-b.json', modifiedTime: old, document: doc('b', { 1: entry(9) }) },
    ];

    // The only evidence of "now" is Drive's own newest write, which is as old as the file.
    expect(findCompactableFiles(entries, { ...options, now: NOW_MS + 10 * STALE_DEVICE_FILE_MS })).toEqual([]);
  });

  it('lists nothing when the document carries entries it could not parse', () => {
    const lossy = { id: 'a', name: 'kandone-a.json', modifiedTime: old, document: doc('a', { 1: entry(5) }), lossy: true };
    const live = { id: 'b', name: 'kandone-b.json', modifiedTime: recent, document: doc('b', { 1: entry(9) }) };

    expect(findCompactableFiles([lossy, live], options)).toEqual([]);
  });
});
