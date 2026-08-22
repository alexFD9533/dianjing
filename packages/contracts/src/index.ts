import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;
export const CSS_PROPERTIES = ['color', 'fontSize', 'margin', 'padding', 'border'] as const;
export type CssProperty = (typeof CSS_PROPERTIES)[number];

export const targetRefSchema = z
  .object({
    editId: z.string().min(1).max(128).optional(),
    fallbackSelector: z.string().min(1).max(512).optional(),
  })
  .refine(
    (value) => value.editId !== undefined || value.fallbackSelector !== undefined,
    'Target needs an identifier',
  );

export const patchSchema = z
  .object({
    id: z.string().min(1),
    target: targetRefSchema,
    kind: z.enum(['text', 'style']),
    property: z.string().min(1),
    before: z.string(),
    after: z.string(),
    createdAt: z.string().datetime(),
  })
  .superRefine((patch, context) => {
    if (
      patch.kind === 'text' &&
      !['textContent', 'directTextContent', 'value'].includes(patch.property)
    )
      context.addIssue({
        code: 'custom',
        message: 'Text uses textContent, directTextContent, or value',
      });
    if (patch.kind === 'style' && !CSS_PROPERTIES.includes(patch.property as CssProperty))
      context.addIssue({ code: 'custom', message: 'Style property is not allowed' });
  });
export type Patch = z.infer<typeof patchSchema>;

export const layoutModuleStateSchema = z.object({
  slotId: z.string().min(1),
  visible: z.boolean(),
  locked: z.boolean(),
});
export const layoutSchemeSchema = z.object({
  pageId: z.string().min(1),
  layoutVersion: z.literal(1),
  slots: z.record(z.string().min(1), z.array(z.string().min(1))),
  modules: z.record(z.string().min(1), layoutModuleStateSchema),
  // Generic-page layout metadata deliberately stays separate from the page DOM.
  // Protocol pages may continue to use slots/modules without this optional block.
  workbench: z
    .object({
      canvas: z.object({
        width: z.number().int().positive().nullable(),
        height: z.number().int().positive().nullable(),
        zoom: z.number().positive(),
        grid: z.boolean(),
        rulers: z.boolean(),
        boundaries: z.boolean(),
        guides: z.boolean(),
      }),
      items: z.record(
        z.string().min(1),
        z.object({
          selector: z.string().min(1),
          // parentSelector is the real DOM parent; containerSelector is an optional
          // visual parent used for safe A-to-B moves without reparenting page DOM.
          parentSelector: z.string().min(1),
          containerSelector: z.string().min(1).optional(),
          left: z.number(),
          top: z.number(),
          width: z.number().positive(),
          height: z.number().positive(),
          zIndex: z.number().int(),
          locked: z.boolean(),
          hidden: z.boolean(),
        }),
      ),
      groups: z.record(
        z.string().min(1),
        z.object({
          name: z.string().min(1).max(100),
          parentSelector: z.string().min(1),
          members: z.array(z.string().min(1)).min(2),
        }),
      ),
    })
    .optional(),
});
export type LayoutScheme = z.infer<typeof layoutSchemeSchema>;

export type LayoutRule = {
  moduleId: string;
  allowedSlots: string[];
  allowHide: boolean;
  locked?: boolean;
};
export const validateLayoutScheme = (scheme: LayoutScheme, rules: LayoutRule[]): string[] => {
  const errors: string[] = [];
  const seen = new Set<string>();
  const ruleMap = new Map(rules.map((rule) => [rule.moduleId, rule]));
  for (const [slotId, moduleIds] of Object.entries(scheme.slots))
    for (const moduleId of moduleIds) {
      if (seen.has(moduleId)) errors.push(`DUPLICATE_MODULE:${moduleId}`);
      seen.add(moduleId);
      const module = scheme.modules[moduleId];
      const rule = ruleMap.get(moduleId);
      if (!module || module.slotId !== slotId) errors.push(`SLOT_MISMATCH:${moduleId}`);
      if (!rule || !rule.allowedSlots.includes(slotId))
        errors.push(`SLOT_NOT_ALLOWED:${moduleId}:${slotId}`);
    }
  for (const [moduleId, module] of Object.entries(scheme.modules)) {
    const rule = ruleMap.get(moduleId);
    if (!seen.has(moduleId)) errors.push(`MISSING_MODULE:${moduleId}`);
    if (module.locked && !rule?.locked) errors.push(`UNDECLARED_LOCK:${moduleId}`);
    if (!module.visible && !rule?.allowHide) errors.push(`HIDE_NOT_ALLOWED:${moduleId}`);
  }
  return errors;
};

export const moveLayoutModule = (
  scheme: LayoutScheme,
  rules: LayoutRule[],
  moduleId: string,
  targetSlotId: string,
  targetIndex: number,
): LayoutScheme => {
  const rule = rules.find((candidate) => candidate.moduleId === moduleId);
  const module = scheme.modules[moduleId];
  if (!rule || !module) throw new Error('MODULE_NOT_FOUND');
  if (module.locked || rule.locked) throw new Error('MODULE_LOCKED');
  if (!rule.allowedSlots.includes(targetSlotId)) throw new Error('SLOT_NOT_ALLOWED');
  const slots = Object.fromEntries(
    Object.entries(scheme.slots).map(([slotId, ids]) => [
      slotId,
      ids.filter((id) => id !== moduleId),
    ]),
  );
  const target = slots[targetSlotId];
  if (!target) throw new Error('SLOT_NOT_FOUND');
  target.splice(Math.max(0, Math.min(targetIndex, target.length)), 0, moduleId);
  const next: LayoutScheme = {
    ...scheme,
    slots,
    modules: { ...scheme.modules, [moduleId]: { ...module, slotId: targetSlotId } },
  };
  const errors = validateLayoutScheme(next, rules);
  if (errors.length) throw new Error(errors.join(','));
  return next;
};

export const schemeSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1).max(100),
  revision: z.number().int().nonnegative(),
  page: z.object({ url: z.string().url(), fingerprint: z.string().optional() }),
  elementPatches: z.array(patchSchema).max(500),
  layout: layoutSchemeSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Scheme = z.infer<typeof schemeSchema>;

export const schemeCollectionSchema = z.object({
  schemaVersion: z.literal(1),
  activeId: z.string().nullable(),
  schemes: z.array(schemeSchema).max(20),
});
export type SchemeCollection = z.infer<typeof schemeCollectionSchema>;

export const schemeExportSchema = z.object({
  exportVersion: z.literal(1),
  scheme: schemeSchema,
});
export type SchemeExport = z.infer<typeof schemeExportSchema>;

export const envelopeSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.string().min(1),
  type: z.enum([
    'session/query',
    'session/enter',
    'session/exit',
    'selection/start',
    'selection/clear',
    'patch/preview',
    'patch/cancel-preview',
    'patch/commit',
    'patch/undo',
    'patch/redo',
    'patch/replay',
    'scheme/save',
    'scheme/read',
    'scheme/reset',
  ]),
  tabId: z.number().int().positive().optional(),
  payload: z.unknown(),
});
export type Envelope = z.infer<typeof envelopeSchema>;
export type Result<T> =
  { ok: true; requestId: string; data: T } | { ok: false; requestId: string; error: AppError };
export type AppError = {
  code: string;
  message: string;
  recoverable: boolean;
  context?: Record<string, string>;
};
export const error = (code: string, message: string, recoverable = true): AppError => ({
  code,
  message,
  recoverable,
});
