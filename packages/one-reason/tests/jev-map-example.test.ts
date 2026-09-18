import { describe, expect, it } from "vitest";
import {
  mapExampleToQuestions,
  toGatewayQuestions,
  toTypesafeQuestions,
} from "../src/jev/map-example.js";

describe("mapExampleToQuestions", () => {
  it("maps booleans to noul, numbers to score, and pipe strings to choice", () => {
    const mapped = mapExampleToQuestions({
      urgent: false,
      severity: 2,
      route: "billing|technical|other",
      note: "keep me",
    });

    expect(mapped.questions.urgent).toMatchObject({ type: "noul" });
    expect(mapped.questions.severity).toMatchObject({ type: "score" });
    expect(mapped.questions.route).toMatchObject({ type: "choice" });
    expect(mapped.questions.note).toBeUndefined();

    const data = mapped.applyAnswers({
      urgent: { type: "noul", noul: 0.91 },
      severity: { type: "score", score: 1.4 },
      route: { type: "choice", choice: "technical" },
    });

    expect(data).toEqual({
      urgent: true,
      severity: 1.4,
      route: "technical",
      note: "keep me",
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
