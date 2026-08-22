import { describe, expect, it } from 'vitest';
import {
  availableWorkspaceSelectionIds,
  reconcileWorkspaceSelectionIds,
} from './workspace-selection';

describe('workspace selection consistency', () => {
  const elements = [{ id: 'container' }, { id: 'text:0' }];

  it('never revives a source selection that is absent from the object state', () => {
    expect(reconcileWorkspaceSelectionIds([], ['missing'], elements)).toEqual([]);
  });

  it('keeps a valid local selection before using the source selection', () => {
    expect(reconcileWorkspaceSelectionIds(['container'], ['text:0'], elements)).toEqual([
      'container',
    ]);
  });

  it('filters every invalid id from a multi-selection', () => {
    expect(availableWorkspaceSelectionIds(['container', 'missing', 'text:0'], elements)).toEqual([
      'container',
      'text:0',
    ]);
  });

  it('keeps a deep selection when the tree projection does not contain it', () => {
    const visibleTree = [{ id: 'root' }];
    const fullSelectableIndex = [...visibleTree, { id: 'deep-other-region' }];
    expect(
      reconcileWorkspaceSelectionIds(['deep-other-region'], ['root'], fullSelectableIndex),
    ).toEqual(['deep-other-region']);
  });
});
