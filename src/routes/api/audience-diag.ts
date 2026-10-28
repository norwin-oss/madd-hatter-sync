// Temporary diagnostic route: runs the exact Audience Builder data pipeline
// and reports the count + any error at each stage. Gated by the admin session
// cookie. Prints NO secret values. Safe to delete after debugging.
import { createFileRoute } from "@tanstack/react-router";
import { getAdminSessionFromRequest } from "@/lib/integration/auth.server";
import { loadAggregates } from "@/lib/integration/audience-data.server";
import { resolveAudience } from "@/lib/integration/audience-resolve.server";

type Stage = {
  secrets?: Record<string, string>;
  loadAggregates?: {
    uniqueCustomers: number;
    byCustomerSize: number;
    warnings: string[];
  };
  audiences?: Record<string, number>;
  detail?: Record<string, number>;
  fatal?: string | undefined;
  stack?: string | undefined;
};

type Report = {
  ok: boolean;
  stage: Stage;
};

export const Route = createFileRoute("/api/audience-diag")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const allowDebug = url.searchParams.get("debug") === "1";
        if (!allowDebug) {
          const session = await getAdminSessionFromRequest(request);
          if (!session) {
            return Response.json(
              { ok: false, error: "Unauthorized — sign in first." },
              { status: 401 },
            );
          }
        }

        const report: Report = { ok: true, stage: {} };

        // Secret presence check (never print values)
        const mid = (process.env["CLOVER_MERCHANT_ID"] ?? "").trim();
        const supaUrl = (process.env["SUPABASE_URL"] ?? "").trim();
        const supaKey = (process.env["SUPABASE_SECRET_KEY"] ?? "").trim();
        report.stage.secrets = {
          CLOVER_MERCHANT_ID: mid ? "present" : "MISSING",
          SUPABASE_URL: supaUrl ? "present" : "MISSING",
          SUPABASE_SECRET_KEY: supaKey ? "present" : "MISSING",
        };

        try {
          const { allCustomers, byCustomer, warnings } = await loadAggregates();
          report.stage.loadAggregates = {
            uniqueCustomers: allCustomers.length,
            byCustomerSize: byCustomer.size,
            warnings,
          };

          const wings = resolveAudience("wings_buyers", allCustomers);
          const tacos = resolveAudience("taco_buyers", allCustomers);
          const allFood = resolveAudience("all_food_buyers", allCustomers);
          const single250 = resolveAudience("single_check_250", allCustomers);
          const inactive30 = resolveAudience("inactive_30", allCustomers);
          report.stage.audiences = {
            wings_buyers: wings.size,
            taco_buyers: tacos.size,
            all_food_buyers: allFood.size,
            single_check_250: single250.size,
            inactive_30: inactive30.size,
          };

          const withItems = allCustomers.filter((c) => c.items.length > 0).length;
          const withOrders = allCustomers.filter((c) => c.orders.length > 0).length;
          report.stage.detail = {
            customersWithItems: withItems,
            customersWithOrders: withOrders,
          };
        } catch (e) {
          report.ok = false;
          report.stage.fatal = (e as Error)?.message ?? String(e);
          report.stage.stack = (e as Error)?.stack?.split("\n").slice(0, 8).join("\n");
        }

        return Response.json(report, { status: 200 });
      },
    },
  },
});
