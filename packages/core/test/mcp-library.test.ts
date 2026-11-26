import { describe, expect, test } from "bun:test";
import { ConnectorManifest, entryProblem, indexEntry, libraryClass, MCP_LIBRARY, MCP_TOOL_CLASSES, mcpLibraryEntry, reviewedEntries } from "../src/index.ts";

/* The library of hosted MCP servers (mcp-library.ts): each one addable as it stands. */

describe("the library of hosted MCP servers", () => {
  test("each has an id a connector may have, its own https address with no query or credentials, and says whether you sign in", () => {
    expect(new Set(MCP_LIBRARY.map((entry) => entry.id)).size).toBe(MCP_LIBRARY.length);
    for (const entry of MCP_LIBRARY) {
      const at = new URL(entry.url);
      expect(at.protocol).toBe("https:");
      expect(at.search + at.hash + at.username + at.password).toBe("");
      expect(["oauth", "none"]).toContain(entry.auth);
      expect(entry.description.length).toBeGreaterThan(10);
      // It makes a manifest the node accepts, as installing it does.
      const manifest = ConnectorManifest.safeParse({ id: entry.id, label: entry.label, origin: at.origin, mcp: { path: at.pathname || "/" }, tools: {}, ...(entry.auth === "oauth" ? { auth: { secret: entry.id, scheme: "oauth", oauth: { provider: "mcp", scopes: [] } } } : {}) });
      expect(manifest.success).toBe(true);
    }
    expect(mcpLibraryEntry("linear")?.url).toBe("https://mcp.linear.app/mcp");
    expect(mcpLibraryEntry("nothing-like-it")).toBeNull();
  });

  test("each reviewed one passes every rule an index entry is held to (its address on its own site), and is marked reviewed", () => {
    for (const entry of reviewedEntries()) {
      expect([entry.id, entryProblem(entry)]).toEqual([entry.id, null]);
      expect(entry.reviewed).toBe(true);
    }
  });

  test("an entry from the index is taken in only as the rules allow, and never as reviewed", () => {
    const good = { id: "acme", label: "Acme", description: "Builds.", url: "https://mcp.acme.example/mcp", site: "acme.example", category: "Developer tools", auth: "oauth", rank: 10, registry: "example.acme/mcp", updated: "", reviewed: true };
    expect(indexEntry(good)).toMatchObject({ id: "acme" });
    expect(indexEntry(good)?.reviewed).toBeUndefined();
    expect(indexEntry({ ...good, url: "https://mcp.elsewhere.example/mcp" })).toBeNull();
    expect(indexEntry({ ...good, category: "Toys" })).toBeNull();
    expect(indexEntry({ ...good, rank: -1 })).toBeNull();
    expect(indexEntry("not an object")).toBeNull();
  });

  test("Dinero's tools are classed as the owner ruled: it reads and prepares drafts on its own; booking, payments, sending, changing and deleting ask", () => {
    // The names Dinero's own server lists (18 November 2026), as the library proposes their classes.
    const classes = Object.fromEntries(
      ["BookVoucher", "book_finance_voucher", "add_invoice_payment", "add_purchase_payment", "send_trade_offer", "update_contact", "submit_feedback", "delete_invoice_draft", "delete_purchase_voucher_draft",
        "GetContactByName", "GetInboxEmailAddresses", "get_report", "list_invoices", "list_vouchers", "SearchBankTransactions",
        "create_invoice", "CreatePurchaseVoucher", "CreateFinanceVoucher", "create_contact", "create_trade_offer", "generate_invoice_from_trade_offer", "upload_file", "attach_file_to_voucher_card", "open_upload_dialog"].map((name) => [name, libraryClass(MCP_TOOL_CLASSES.dinero, name)]),
    );
    expect(classes).toEqual({
      BookVoucher: "outward", book_finance_voucher: "outward", add_invoice_payment: "outward", add_purchase_payment: "outward", send_trade_offer: "outward", update_contact: "outward", submit_feedback: "outward",
      // Attaching a file to a voucher's card changes the books (Dinero's own words): it asks, as changing what is there does.
      attach_file_to_voucher_card: "outward",
      delete_invoice_draft: "delete", delete_purchase_voucher_draft: "delete",
      GetContactByName: "read", GetInboxEmailAddresses: "read", get_report: "read", list_invoices: "read", list_vouchers: "read", SearchBankTransactions: "read",
      create_invoice: "create", CreatePurchaseVoucher: "create", CreateFinanceVoucher: "create", create_contact: "create", create_trade_offer: "create", generate_invoice_from_trade_offer: "create", upload_file: "create",
      // A tool it doesn't name is left to the server's hints (and asks, where they say nothing).
      open_upload_dialog: null,
    });
    // Only the reviewed list proposes; a pattern's dots are letters, not "any character".
    expect(libraryClass(undefined, "create_invoice")).toBeNull();
    expect(libraryClass([["get.x", "read"]], "getax")).toBeNull();
    expect(mcpLibraryEntry("dinero")).toMatchObject({ url: "https://mcp.dinero.dk/", auth: "oauth", site: "dinero.dk", category: "Finance" });
  });
});
