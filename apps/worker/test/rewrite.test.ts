import { describe, expect, it } from "vitest";

import { authenticatedFromDomain, checkSender, cloudflareAuthResults } from "../src/auth";
import { getHeader, parseAddressList, parseMessage, serializeMessage } from "../src/mime";
import { keyedReverseAddress, parseReverseTag, readableReverseAddress } from "../src/reverse";
import { rewriteInbound, rewriteOutbound } from "../src/rewrite";

const encoder = new TextEncoder();

describe("parseAddressList", () => {
    it("handles quotes, encoded words, groups and comments", () => {
        expect(
            parseAddressList(
                '"Doe, Jane" <jane@x.test>, bob@y.test (Bob), =?UTF-8?B?w4RyZ2Vy?= <a@z.test>, team: c@t.test, d@t.test;',
            ),
        ).toEqual([
            { name: "Doe, Jane", address: "jane@x.test" },
            { name: "", address: "bob@y.test" },
            { name: "Ärger", address: "a@z.test" },
            { name: "", address: "c@t.test" },
            { name: "", address: "d@t.test" },
        ]);
    });
});

describe("parseMessage", () => {
    it("never leaves a CR in header values (the Email Service rejects bare CRs)", () => {
        for (const eol of ["\r\n", "\n"]) {
            const raw = ["Subject: Hi", "Content-Type: text/plain;", " charset=utf-8", "", "Body"];
            const parsed = parseMessage(encoder.encode(raw.join(eol)));
            expect(parsed.headers.map((h) => h.value.replace(/\r\n /g, " "))).toEqual([
                "Hi",
                "text/plain; charset=utf-8",
            ]);
            expect(new TextDecoder().decode(parsed.body)).toBe("Body");
            const serialized = new TextDecoder().decode(serializeMessage(parsed));
            expect(serialized.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
        }
    });
});

describe("reverse addresses", () => {
    it("splits at the last '=' so contact local parts need no escaping", () => {
        expect(parseReverseTag("bob=shop.test")).toEqual({
            kind: "address",
            contact: "bob@shop.test",
        });
        expect(parseReverseTag("a+b=c=Shop.TEST")).toEqual({
            kind: "address",
            contact: "a+b=c@shop.test",
        });
        expect(parseReverseTag("=k3x9q2m7p4")).toEqual({ kind: "key", key: "k3x9q2m7p4" });
        expect(parseReverseTag("promo")).toBeNull();
        expect(parseReverseTag("bob=")).toBeNull();
        expect(parseReverseTag("bob=notadomain")).toBeNull();
    });

    it("uses the readable form only within the 64-character local-part limit", () => {
        expect(readableReverseAddress("me@a.test", "bob@shop.test")).toBe(
            "me+bob=shop.test@a.test",
        );
        expect(readableReverseAddress("me@a.test", `${"x".repeat(60)}@shop.test`)).toBeNull();
    });
});

function message(headers: string[], body: Uint8Array | string = "Body") {
    const head = encoder.encode(`${headers.join("\r\n")}\r\n\r\n`);
    const bytes = typeof body === "string" ? encoder.encode(body) : body;
    const out = new Uint8Array(head.length + bytes.length);
    out.set(head);
    out.set(bytes, head.length);
    return parseMessage(out);
}

const names = (headers: { name: string }[]) => headers.map((h) => h.name.toLowerCase());

describe("rewriteInbound", () => {
    it("keeps the aliases a message already passed through, and adds its own", async () => {
        const original = message([
            "From: bob@shop.test",
            "To: first@other.test",
            "X-Mailflare-Alias: first@other.test",
            "Subject: Chained",
        ]);
        const out = await rewriteInbound(original, {
            alias: "alias@me.test",
            envelopeFrom: "first@other.test",
            toReverse: async (contact) => `alias+${contact.replace("@", "=")}@me.test`,
        });
        const hops = out.headers
            .filter((h) => h.name.toLowerCase() === "x-mailflare-alias")
            .map((h) => h.value);
        expect(hops).toEqual(["first@other.test", "alias@me.test"]);
    });

    it("turns senders and other recipients into reverse addresses and drops traces", async () => {
        // An 8-bit (Latin-1) body must pass through byte for byte.
        const body = new Uint8Array([0x48, 0xe9, 0x6c, 0x6c, 0x6f]);
        const original = message(
            [
                "Received: from mx.shop.test",
                "DKIM-Signature: v=1; d=shop.test",
                'From: "Bob" <bob@shop.test>',
                "Reply-To: support@shop.test",
                "To: alias@me.test, carol@other.test",
                "Cc: dave@other.test",
                "Subject: Order",
                "List-Unsubscribe: <https://shop.test/u>",
                "X-Tracking: 123",
                "Content-Type: text/plain; charset=iso-8859-1",
            ],
            body,
        );

        const out = await rewriteInbound(original, {
            alias: "alias@me.test",
            envelopeFrom: "bounce@shop.test",
            toReverse: async (contact) => `alias+${contact.replace("@", "=")}@me.test`,
        });

        expect(getHeader(out.headers, "From")).toBe(
            '"Bob (bob at shop.test)" <alias+bob=shop.test@me.test>',
        );
        expect(getHeader(out.headers, "Reply-To")).toBe(
            '"support at shop.test" <alias+support=shop.test@me.test>',
        );
        expect(getHeader(out.headers, "To")).toBe(
            'alias@me.test, "carol at other.test" <alias+carol=other.test@me.test>',
        );
        expect(getHeader(out.headers, "Cc")).toBe(
            '"dave at other.test" <alias+dave=other.test@me.test>',
        );
        expect(getHeader(out.headers, "X-Mailflare-Alias")).toBe("alias@me.test");
        expect(names(out.headers)).toContain("list-unsubscribe");
        for (const dropped of ["received", "dkim-signature", "x-tracking"]) {
            expect(names(out.headers)).not.toContain(dropped);
        }
        expect(Array.from(out.body)).toEqual(Array.from(body));
        // Serializing keeps the body bytes as well.
        const serialized = serializeMessage(out);
        expect(Array.from(serialized.slice(-body.length))).toEqual(Array.from(body));
    });
});

describe("rewriteOutbound", () => {
    it("sends from the alias, restores contacts and removes the owner's traces", async () => {
        const original = message([
            "Received: from mail.inbox.test",
            'From: "Me Myself" <me@inbox.test>',
            "Reply-To: me@inbox.test",
            'To: "Bob (bob at shop.test)" <alias+bob=shop.test@me.test>',
            "Cc: friend@other.test",
            "Subject: Re: Order",
            "Message-ID: <abc@mail.inbox.test>",
            "In-Reply-To: <1@shop.test>",
            "References: <0@mail.inbox.test> <1@shop.test>",
            "X-Pm-Origin: internal",
        ]);

        const out = await rewriteOutbound(original, {
            alias: "alias@me.test",
            fromReverse: async (address) =>
                address === "alias+bob=shop.test@me.test" ? "bob@shop.test" : null,
            messageId: "<new@me.test>",
            messageIds: new Map([["<0@mail.inbox.test>", "<earlier@me.test>"]]),
        });

        expect(getHeader(out.headers, "From")).toBe("alias@me.test");
        expect(getHeader(out.headers, "To")).toBe('"Bob" <bob@shop.test>');
        expect(getHeader(out.headers, "Cc")).toBe("friend@other.test");
        expect(getHeader(out.headers, "In-Reply-To")).toBe("<1@shop.test>");
        // No Message-ID on the owner's mail domain, earlier ones as the contact saw them.
        expect(out.headers.filter((h) => h.name === "Message-ID")).toEqual([
            { name: "Message-ID", value: "<new@me.test>" },
        ]);
        expect(getHeader(out.headers, "References")).toBe("<earlier@me.test> <1@shop.test>");
        for (const dropped of ["received", "reply-to", "x-pm-origin"]) {
            expect(names(out.headers)).not.toContain(dropped);
        }
    });
});

describe("owner check", () => {
    const headers = (lines: string[]) => message(lines).headers;

    const reverse = "alias+bob=shop.test@me.test";

    it("reads only the topmost Authentication-Results, and only Cloudflare's", () => {
        const [dmarc] = cloudflareAuthResults(
            headers([
                "Authentication-Results: mx.cloudflare.net;\r\n dmarc=pass header.from=inbox.test",
            ]),
        )!;
        expect(dmarc).toMatchObject({ method: "dmarc", result: "pass" });
        expect(dmarc!.properties.get("header.from")).toBe("inbox.test");
        expect(
            cloudflareAuthResults(
                headers([
                    "Authentication-Results: spoof.example; dmarc=pass",
                    "Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=inbox.test",
                ]),
            ),
        ).toBeNull();
    });

    it("reads each result on its own, not words from other results or comments", () => {
        const results = cloudflareAuthResults(
            headers([
                "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=x.test header.s=dmarc=pass (dmarc=pass header.from=inbox.test); dmarc=fail header.from=evil.test",
            ]),
        )!;
        const dmarc = results.find((r) => r.method === "dmarc");
        expect(dmarc?.result).toBe("fail");
        expect(dmarc?.properties.get("header.from")).toBe("evil.test");
    });

    it("accepts bounce-style envelope senders on the owner's domain", () => {
        const lines = [
            "From: me@inbox.test",
            `To: ${reverse}`,
            "Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=inbox.test",
        ];
        expect(
            checkSender(headers(lines), "bounce+123@mail.inbox.test", "me@inbox.test", reverse),
        ).toEqual({ owner: true, authenticated: true });
        expect(checkSender(headers(lines), "me@evil.test", "me@inbox.test", reverse)).toMatchObject(
            { owner: true, authenticated: false },
        );
    });

    it("needs header.from, and the reverse address it was delivered to in To or Cc", () => {
        const withoutHeaderFrom = [
            "From: me@inbox.test",
            `To: ${reverse}`,
            "Authentication-Results: mx.cloudflare.net; dmarc=pass",
        ];
        expect(
            checkSender(headers(withoutHeaderFrom), "me@inbox.test", "me@inbox.test", reverse),
        ).toMatchObject({ authenticated: false });
        // A signed message of the owner, replayed to another reverse address.
        const replayed = [
            "From: me@inbox.test",
            `To: ${reverse}`,
            "Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=inbox.test",
        ];
        expect(
            checkSender(
                headers(replayed),
                "me@inbox.test",
                "me@inbox.test",
                "alias+victim=else.test@me.test",
            ),
        ).toMatchObject({ authenticated: false, reason: "recipient not in To or Cc" });
    });

    it("authenticates a sender by DMARC, or by SPF on the From domain", () => {
        const from = (auth: string) =>
            authenticatedFromDomain(
                headers([
                    "From: bob@shop.test",
                    `Authentication-Results: mx.cloudflare.net; ${auth}`,
                ]),
            );
        expect(from("dmarc=pass header.from=shop.test")).toBe("shop.test");
        expect(from("spf=pass smtp.mailfrom=bounce@mail.shop.test; dmarc=none")).toBe("shop.test");
        expect(from("spf=pass smtp.mailfrom=me@throwaway.test; dmarc=none")).toBeNull();
        expect(from("dmarc=pass header.from=throwaway.test")).toBeNull();
    });
});

describe("reverse addresses", () => {
    it("use the readable form only when it reads back as the same contact", () => {
        expect(readableReverseAddress("a@me.test", "bob@shop.xn--p1ai")).toBe(
            "a+bob=shop.xn--p1ai@me.test",
        );
        expect(parseReverseTag("bob=shop.xn--p1ai")).toEqual({
            kind: "address",
            contact: "bob@shop.xn--p1ai",
        });
        expect(readableReverseAddress("a@me.test", "=x@shop.test")).toBeNull();
        expect(readableReverseAddress("a@me.test", "bob@[192.0.2.1]")).toBeNull();
        expect(keyedReverseAddress("a@me.test", "k3x9q2m7p4")).toBe("a+=k3x9q2m7p4@me.test");
    });
});

describe("rewriteInbound extras", () => {
    it("drops mailto list links, leaves out recipients without a reverse address, maps IDs back", async () => {
        const original = message([
            "From: news@shop.test",
            "To: alias@me.test, other@shop.test",
            "List-Unsubscribe: <mailto:unsub@shop.test>, <https://shop.test/unsub>",
            "List-Post: <mailto:list@shop.test>",
            "In-Reply-To: <sent@me.test>",
        ]);
        const out = await rewriteInbound(original, {
            alias: "alias@me.test",
            envelopeFrom: "news@shop.test",
            toReverse: async (contact) =>
                contact === "news@shop.test" ? "alias+news=shop.test@me.test" : null,
            messageIds: new Map([["<sent@me.test>", "<original@mail.inbox.test>"]]),
        });
        expect(getHeader(out.headers, "List-Unsubscribe")).toBe("<https://shop.test/unsub>");
        expect(names(out.headers)).not.toContain("list-post");
        expect(getHeader(out.headers, "To")).toBe("alias@me.test");
        expect(getHeader(out.headers, "In-Reply-To")).toBe("<original@mail.inbox.test>");
    });
});
