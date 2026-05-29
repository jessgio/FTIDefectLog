/** User-facing dashboard copy (single source — avoid stale strings in components). */
export const dashboardCopy = {
  subtitle: "Live defective stock levels and value",
  loadErrorHint: "Check your connection and sign in with an allowed company account.",
  cogsEmptyHint: "No COGS on filtered lots (fill cogs_per_unit in the product catalog).",
  footer: "Log stock changes on Stock entry; edit or undo past entries on History.",
} as const;
