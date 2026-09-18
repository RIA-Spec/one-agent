import { describe, expect, it } from "vitest";
import {
  classifyExampleForJev,
  isJevDecisionExample,
  mapExampleToQuestions,
  mapExplicitQuestions,
  toGatewayQuestions,
  toTypesafeQuestions,
} from "../src/jev/map-example.js";

describe("mapExampleToQuestions", () => {
  it("maps booleans to noul, numbers to score, and pipe strings to choice", () => {
    const mapped = mapExampleToQuestions({
      urgent: false,
      severity: 2,
      route: "billing|technical|other",
    });

    expect(mapped.questions.urgent).toMatchObject({ type: "noul" });
    expect(mapped.questions.severity).toMatchObject({ type: "score" });
    expect(mapped.questions.route).toMatchObject({ type: "choice" });

    const data = mapped.applyAnswers({
      urgent: { type: "noul", noul: 0.91 },
      severity: { type: "score", score: 1.4 },
      route: { type: "choice", choice: "technical" },
    });

    expect(data).toEqual({
      urgent: true,
      severity: 1.4,
      route: "technical",
    });
  });

  it("respects booleanThreshold when applying noul answers", () => {
    const mapped = mapExampleToQuestions({ ok: false });
    expect(mapped.applyAnswers({ ok: { type: "noul", noul: 0.55 } }, 0.5)).toEqual({
      ok: true,
    });
    expect(mapped.applyAnswers({ ok: { type: "noul", noul: 0.55 } }, 0.6)).toEqual({
      ok: false,
    });
  });

  it("supports nested objects and explicit $jev markers", () => {
    const mapped = mapExampleToQuestions({
      ticket: {
        refund: {
          $jev: "noul",
          instructions: "Was a refund issued?",
          value: false,
        },
        queue: {
          $jev: "choice",
          criteria: { billing: "payments", support: "everything else" },
          value: "billing",
        },
      },
    });

    expect(mapped.questions["ticket.refund"]?.type).toBe("noul");
    expect(mapped.questions["ticket.queue"]?.type).toBe("choice");

    const data = mapped.applyAnswers({
      "ticket.refund": { type: "boolean", probability: 0.12 },
      "ticket.queue": { type: "choice", choice: "support" },
    });

    expect(data).toEqual({
      ticket: {
        refund: false,
        queue: "support",
      },
    });
  });

  it("maps string arrays to choice questions", () => {
    const mapped = mapExampleToQuestions({
      category: ["bug", "feature", "other"],
    });
    expect(mapped.questions.category).toMatchObject({
      type: "choice",
      criteria: { bug: null, feature: null, other: null },
    });
  });

  it("throws when no questions can be derived", () => {
    expect(() => mapExampleToQuestions({ text: "hello" })).toThrow(/could not derive/);
  });
});

describe("classifyExampleForJev", () => {
  it("marks pure decision examples as jev-decision", () => {
    expect(isJevDecisionExample({ retry: false, route: "a|b|c", score: 2 })).toBe(true);
    const classified = classifyExampleForJev({ retry: false });
    expect(classified.kind).toBe("jev-decision");
  });

  it("marks free-text / summary examples as llm-synthesis", () => {
    expect(isJevDecisionExample({ summary: "", findings: "", next: "" })).toBe(false);
    const classified = classifyExampleForJev({
      summary: "brief",
      findings: "none",
      next: "wait",
    });
    expect(classified.kind).toBe("llm-synthesis");
    if (classified.kind === "llm-synthesis") {
      expect(classified.reason).toMatch(/free-text/);
    }
  });

  it("marks mixed decision + free-text as llm-synthesis", () => {
    const classified = classifyExampleForJev({
      urgent: false,
      note: "keep me",
    });
    expect(classified.kind).toBe("llm-synthesis");
    if (classified.kind === "llm-synthesis") {
      expect(classified.freeTextPaths).toContain("note");
      expect(classified.questions.urgent).toMatchObject({ type: "noul" });
    }
  });
});

describe("mapExplicitQuestions", () => {
  it("applies answers onto the example skeleton using provided questions", () => {
    const mapped = mapExplicitQuestions(
      { ok: false },
      { ok: { type: "noul", instructions: "Did it succeed?" } },
    );
    expect(mapped.applyAnswers({ ok: { type: "noul", noul: 0.9 } })).toEqual({ ok: true });
  });
});

describe("wire format conversion", () => {
  it("emits noul for TypeSafe and boolean for Gateway", () => {
    const mapped = mapExampleToQuestions({ ok: true });
    expect(toTypesafeQuestions(mapped.questions)).toEqual({
      ok: { type: "noul", instructions: expect.any(String) },
    });
    expect(toGatewayQuestions(mapped.questions)).toEqual({
      ok: { type: "boolean", instructions: expect.any(String) },
    });
  });
});
