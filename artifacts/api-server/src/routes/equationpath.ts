import { Router, type IRouter, type Request, type Response } from "express";
import {
  AnalyzeDatasetBody,
  AnalyzeDatasetResponse,
  CheckEquationBody,
  CheckEquationResponse,
  GetExamplesResponse,
  PlotEquationBody,
  PlotEquationResponse,
  SolveEquationBody,
  SolveEquationResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();
const mathServiceUrl = process.env.MATH_SERVICE_URL ?? "http://127.0.0.1:8765";

async function forward(
  req: Request,
  res: Response,
  path: string,
  body?: unknown,
): Promise<unknown | null> {
  try {
    const response = await fetch(`${mathServiceUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const result: unknown = await response.json();
    if (!response.ok) {
      const detail =
        typeof result === "object" &&
        result !== null &&
        "detail" in result &&
        typeof result.detail === "string"
          ? result.detail
          : "The math service could not process this request.";
      res.status(response.status).json({ error: detail });
      return null;
    }
    return result;
  } catch (error) {
    req.log.error({ error, path }, "EquationPath math service request failed");
    res.status(503).json({ error: "The math service is unavailable. Please try again shortly." });
    return null;
  }
}

function validateBody<T>(
  req: Request,
  res: Response,
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { message: string } } },
): T | null {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return null;
  }
  return parsed.data;
}

router.post("/equations/check", async (req, res): Promise<void> => {
  const input = validateBody(req, res, CheckEquationBody);
  if (!input) return;
  const result = await forward(req, res, "/equations/check", input);
  if (result === null) return;
  res.json(CheckEquationResponse.parse(result));
});

router.post("/equations/solve", async (req, res): Promise<void> => {
  const input = validateBody(req, res, SolveEquationBody);
  if (!input) return;
  const result = await forward(req, res, "/equations/solve", input);
  if (result === null) return;
  res.json(SolveEquationResponse.parse(result));
});

router.post("/equations/plot", async (req, res): Promise<void> => {
  const input = validateBody(req, res, PlotEquationBody);
  if (!input) return;
  const result = await forward(req, res, "/equations/plot", input);
  if (result === null) return;
  res.json(PlotEquationResponse.parse(result));
});

router.post("/data/analyze", async (req, res): Promise<void> => {
  const input = validateBody(req, res, AnalyzeDatasetBody);
  if (!input) return;
  const result = await forward(req, res, "/data/analyze", input);
  if (result === null) return;
  res.json(AnalyzeDatasetResponse.parse(result));
});

router.post("/data/fit-ode", async (req, res): Promise<void> => {
  const body: unknown = req.body;
  if (!body || typeof body !== "object" || !("m" in body) || !("n" in body) ||
      !("observations" in body) || typeof body.m !== "string" || typeof body.n !== "string" ||
      body.m.length > 400 || body.n.length > 400 || !Array.isArray(body.observations) ||
      body.observations.length < 3 || body.observations.length > 200) {
    res.status(400).json({ error: "Provide valid M, N and 3–200 observations." });
    return;
  }
  const result = await forward(req, res, "/data/fit-ode", body);
  if (result !== null) res.json(result);
});

router.get("/examples", async (req, res): Promise<void> => {
  const result = await forward(req, res, "/examples");
  if (result === null) return;
  res.json(GetExamplesResponse.parse(result));
});

export default router;
