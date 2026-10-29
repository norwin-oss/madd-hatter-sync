import { createFileRoute } from "@tanstack/react-router";
import { HistoricalImportPage } from "@/components/historical-import-page";

export const Route = createFileRoute("/_authenticated/admin/historical-import")({
  head: () => ({
    meta: [
      { title: "Historical Import — Madd Hatter POS Sync" },
      {
        name: "description",
        content:
          "Backfill complete historical Clover order and line-item data into the dashboard for full reporting coverage.",
      },
    ],
  }),
  component: HistoricalImportPage,
});
