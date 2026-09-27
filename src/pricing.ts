// Pricing calculator (the owner, 2026-09-25: "include the pricing in the app").
//
// Prices an AI-accelerated build on value rather than hours: the cost floor, the client's alternatives
// (a traditional team, off-the-shelf software), the value created, and four ways to charge. It is pure
// client-side arithmetic, so the page is static: the calculator itself lives in pricing/calculator.html,
// which wrangler bundles as a Text module, and is rendered inside layout() here so it gets the rail,
// sign-in and the app's theme. Inputs are remembered per browser (localStorage); nothing is stored here.
import { Hono } from "hono";
import CALCULATOR from "./pricing/calculator.html";
import { esc, layout } from "./views";
import { appSettings } from "./settings";
import type { Bindings } from "./types";

const app = new Hono<{ Bindings: Bindings }>();

app.get("/pricing", (c) =>
  c.html(
    layout({
      c,
      title: "Pricing",
      // The firm name is a setting (Phase 3a); the calculator file carries a {{FIRM}} placeholder.
      body: `<main>${CALCULATOR.replace("{{FIRM}}", esc(appSettings().firm))}</main>`,
    })
  )
);

export default app;
