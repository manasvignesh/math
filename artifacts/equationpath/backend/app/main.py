from __future__ import annotations

import ast
import csv
import math
from pathlib import Path
from typing import Any, Literal

import numpy as np
import sympy as sp
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from scipy.integrate import solve_ivp
from scipy.optimize import least_squares

x, y = sp.symbols("x y", real=True)
_ALLOWED_FUNCTIONS = {
    "sin": sp.sin,
    "cos": sp.cos,
    "tan": sp.tan,
    "asin": sp.asin,
    "acos": sp.acos,
    "atan": sp.atan,
    "sinh": sp.sinh,
    "cosh": sp.cosh,
    "tanh": sp.tanh,
    "exp": sp.exp,
    "log": sp.log,
    "sqrt": sp.sqrt,
    "abs": sp.Abs,
}
_CONSTANTS = {"pi": sp.pi, "E": sp.E}
_DATA_DIR = Path(__file__).resolve().parents[2] / "datasets"

app = FastAPI(title="EquationPath Math API", version="1.0.0")


class EquationInput(BaseModel):
    m: str = Field(min_length=1, max_length=400)
    n: str = Field(min_length=1, max_length=400)


class PlotInput(EquationInput):
    x0: float
    y0: float
    x_min: float = -5
    x_max: float = 5
    points: int = Field(default=240, ge=40, le=600)


class Observation(BaseModel):
    x_value: float
    observed_y: float


class NumericalFitInput(EquationInput):
    observations: list[Observation] = Field(min_length=3, max_length=200)
    x0: float = 0.0
    initial_guess: float = 1.0


class AnalyzeInput(BaseModel):
    model: Literal["decay", "growth", "quadratic"]
    observations: list[Observation] = Field(min_length=2, max_length=2000)
    fit_parameter: bool = True
    known_parameter: float | None = None


def _from_ast(node: ast.AST) -> sp.Expr:
    if isinstance(node, ast.Expression):
        return _from_ast(node.body)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return sp.Integer(node.value) if isinstance(node.value, int) else sp.Float(node.value)
    if isinstance(node, ast.Name):
        known: dict[str, Any] = {"x": x, "y": y, **_CONSTANTS}
        if node.id not in known:
            raise ValueError(f"Unknown symbol '{node.id}'. Use only x, y, pi, and E.")
        return known[node.id]
    if isinstance(node, ast.BinOp):
        left, right = _from_ast(node.left), _from_ast(node.right)
        operations = {
            ast.Add: lambda: left + right,
            ast.Sub: lambda: left - right,
            ast.Mult: lambda: left * right,
            ast.Div: lambda: left / right,
            ast.Pow: lambda: left**right,
        }
        operation = operations.get(type(node.op))
        if operation is None:
            raise ValueError("Only +, -, *, /, and ** operators are supported.")
        return operation()
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
        value = _from_ast(node.operand)
        return value if isinstance(node.op, ast.UAdd) else -value
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
        function = _ALLOWED_FUNCTIONS.get(node.func.id)
        if function is None or node.keywords:
            raise ValueError("That function is not supported.")
        if len(node.args) != 1:
            raise ValueError("Supported functions take one argument.")
        return function(_from_ast(node.args[0]))
    raise ValueError("Use a mathematical expression; arbitrary Python syntax is not allowed.")


def parse_expression(source: str) -> sp.Expr:
    if not source.strip():
        raise ValueError("Enter an expression for both M and N.")
    try:
        expression = sp.sympify(_from_ast(ast.parse(source, mode="eval")))
    except (SyntaxError, TypeError, ZeroDivisionError) as exc:
        raise ValueError("Could not parse that expression. Check operators and parentheses.") from exc
    if not expression.free_symbols.issubset({x, y}):
        raise ValueError("Only x and y may be used as variables.")
    if sp.count_ops(expression) > 160:
        raise ValueError("This expression is too complex to process safely.")
    return expression


def _parsed(m_text: str, n_text: str) -> tuple[sp.Expr, sp.Expr]:
    try:
        return parse_expression(m_text), parse_expression(n_text)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _string(expr: sp.Expr) -> str:
    return sp.sstr(sp.simplify(expr))


def _dependence(expr: sp.Expr, variable: sp.Symbol) -> bool:
    return sp.simplify(expr).free_symbols.issubset({variable})


def exactness(m: sp.Expr, n: sp.Expr) -> dict[str, Any]:
    m_y = sp.simplify(sp.diff(m, y))
    n_x = sp.simplify(sp.diff(n, x))
    difference = sp.simplify(m_y - n_x)
    method, factor, explanation = "none", None, "The equation is not exact; no supported one-variable integrating factor was identified."
    is_exact = difference == 0
    if is_exact:
        method = "exact"
        explanation = "The mixed partial derivatives simplify to the same expression."
    elif sp.simplify(m) != 0:
        ratio_y = sp.simplify(-difference / m)
        if _dependence(ratio_y, y) and ratio_y.free_symbols:
            method, factor = "integrating_factor_y", sp.simplify(sp.exp(sp.integrate(ratio_y, y)))
            explanation = "The integrating-factor test depends only on y; the transformed equation will be checked before solving."
    if not is_exact and method == "none" and sp.simplify(n) != 0:
        ratio_x = sp.simplify(difference / n)
        if _dependence(ratio_x, x) and ratio_x.free_symbols:
            method, factor = "integrating_factor_x", sp.simplify(sp.exp(sp.integrate(ratio_x, x)))
            explanation = "The integrating-factor test depends only on x; the transformed equation will be checked before solving."
    return {
        "m": _string(m), "n": _string(n), "m_y": _string(m_y), "n_x": _string(n_x),
        "difference": _string(difference), "is_exact": is_exact, "method": method,
        "factor": _string(factor) if factor is not None else None, "explanation": explanation,
        "_m": m, "_n": n, "_factor": factor,
    }


def _solve_exact(m: sp.Expr, n: sp.Expr) -> tuple[sp.Expr | None, list[str], dict[str, bool]]:
    try:
        integrated_m = sp.integrate(m, x)
        g_prime = sp.simplify(n - sp.diff(integrated_m, y))
        if x in g_prime.free_symbols:
            return None, [], {"F_x_equals_M": False, "F_y_equals_N": False}
        g = sp.integrate(g_prime, y)
        if g.has(sp.Integral):
            return None, [], {"F_x_equals_M": False, "F_y_equals_N": False}
        potential = sp.simplify(integrated_m + g)
        verified_x = sp.simplify(sp.diff(potential, x) - m) == 0
        verified_y = sp.simplify(sp.diff(potential, y) - n) == 0
        steps = [
            f"Integrate M with respect to x: {sp.sstr(integrated_m)} + g(y)",
            f"Differentiate with respect to y: {sp.sstr(sp.diff(integrated_m, y))} + g'(y)",
            f"Match with N to obtain g'(y) = {sp.sstr(g_prime)}",
            f"Integrate g'(y): g(y) = {sp.sstr(g)}",
            f"Construct F(x,y) = {sp.sstr(potential)}",
            f"Verify F_x − M = {sp.sstr(sp.simplify(sp.diff(potential, x) - m))} and F_y − N = {sp.sstr(sp.simplify(sp.diff(potential, y) - n))}",
        ]
        return potential, steps, {"F_x_equals_M": verified_x, "F_y_equals_N": verified_y}
    except (NotImplementedError, ValueError, TypeError, RecursionError):
        return None, [], {"F_x_equals_M": False, "F_y_equals_N": False}


def solve(m: sp.Expr, n: sp.Expr) -> dict[str, Any]:
    analysis = exactness(m, n)
    method = analysis["method"]
    warnings: list[str] = []
    restrictions: list[str] = []
    transformed_m, transformed_n = m, n
    if method.startswith("integrating_factor"):
        factor = analysis["_factor"]
        if factor is None or factor.has(sp.Integral) or factor.is_zero is True:
            method = "unsupported"
        else:
            transformed_m, transformed_n = sp.simplify(factor * m), sp.simplify(factor * n)
            if sp.simplify(sp.diff(transformed_m, y) - sp.diff(transformed_n, x)) != 0:
                method = "unsupported"
                warnings.append("The proposed integrating factor did not pass symbolic exactness verification.")
            else:
                variable = "x" if method.endswith("_x") else "y"
                restrictions.append(f"Integrating factor is applied on intervals where it is defined and nonzero ({variable} ≠ 0 where applicable).")
                warnings.append("Multiplication by an integrating factor may exclude branches on its singular set; retain the original equation's domain.")
    if method == "none" or method == "unsupported":
        return {
            "status": "unsupported", "method": method, "potential": None, "implicit_solution": None,
            "steps": [analysis["explanation"]], "verification": {"F_x_equals_M": False, "F_y_equals_N": False},
            "domain_restrictions": restrictions, "warnings": warnings,
        }
    potential, steps, verification = _solve_exact(transformed_m, transformed_n)
    if potential is None or not all(verification.values()):
        return {
            "status": "integration_unavailable", "method": method, "potential": None, "implicit_solution": None,
            "steps": ["Symbolic integration did not produce a verifiable potential function."],
            "verification": verification, "domain_restrictions": restrictions,
            "warnings": warnings + ["The expression was accepted, but a complete symbolic solution could not be verified."],
        }
    if method != "exact":
        steps.insert(0, f"Apply integrating factor μ = {analysis['factor']} to both terms.")
        steps.insert(1, "Verify the transformed equation is exact before integrating.")
    return {
        "status": "solved", "method": method, "potential": _string(potential),
        "implicit_solution": f"{_string(potential)} = C", "steps": steps,
        "verification": verification, "domain_restrictions": restrictions, "warnings": warnings,
    }


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/equations/check")
def check_equation(request: EquationInput) -> dict[str, Any]:
    m, n = _parsed(request.m, request.n)
    result = exactness(m, n)
    result.pop("_m", None)
    result.pop("_n", None)
    result.pop("_factor", None)
    return result


@app.post("/equations/solve")
def solve_equation(request: EquationInput) -> dict[str, Any]:
    m, n = _parsed(request.m, request.n)
    return solve(m, n)


def _integrate_direction(m: sp.Expr, n: sp.Expr, initial: tuple[float, float], bound: float, points: int) -> tuple[list[float], list[float], bool]:
    x0, y0 = initial
    if math.isclose(x0, bound):
        return [], [], False
    grid = np.linspace(x0, bound, max(2, int(points * abs(bound - x0) / max(abs(bound), abs(x0), 1e-6))))
    m_func = sp.lambdify((x, y), m, modules=["numpy"])
    n_func = sp.lambdify((x, y), n, modules=["numpy"])
    invalid = False

    def derivative(x_value: float, state: np.ndarray) -> list[float]:
        nonlocal invalid
        try:
            numerator = float(m_func(x_value, state[0]))
            denominator = float(n_func(x_value, state[0]))
            if not math.isfinite(numerator) or not math.isfinite(denominator) or abs(denominator) < 1e-10:
                invalid = True
                return [math.copysign(1e8, -numerator or 1)]
            slope = -numerator / denominator
            if not math.isfinite(slope) or abs(slope) > 1e8:
                invalid = True
                return [math.copysign(1e8, slope or 1)]
            return [slope]
        except (TypeError, ValueError, ZeroDivisionError, OverflowError):
            invalid = True
            return [1e8]

    solution = solve_ivp(
        derivative, (x0, bound), [y0], t_eval=grid, rtol=1e-7, atol=1e-9,
        max_step=max(abs(bound - x0) / 100, 1e-3),
    )
    xs = solution.t.tolist()
    ys = solution.y[0].tolist() if solution.y.size else []
    return xs, ys, invalid or not solution.success or len(xs) < len(grid)


@app.post("/equations/plot")
def plot_equation(request: PlotInput) -> dict[str, Any]:
    if request.x_min >= request.x_max or not request.x_min <= request.x0 <= request.x_max:
        raise HTTPException(status_code=400, detail="Choose increasing x bounds that contain the initial x-value.")
    m, n = _parsed(request.m, request.n)
    if sp.simplify(n) == 0:
        raise HTTPException(status_code=400, detail="N is zero, so dy/dx = −M/N is undefined.")
    left_x, left_y, left_warn = _integrate_direction(m, n, (request.x0, request.y0), request.x_min, request.points // 2)
    right_x, right_y, right_warn = _integrate_direction(m, n, (request.x0, request.y0), request.x_max, request.points // 2)
    xs = list(reversed(left_x[1:])) + right_x
    ys = list(reversed(left_y[1:])) + right_y
    warnings = []
    if left_warn or right_warn:
        warnings.append("Numerical integration stopped or encountered a singularity; only the valid segment is shown.")
    return {"x": xs, "y": ys, "x0": request.x0, "y0": request.y0, "warnings": warnings, "method": "Numerical solution via SciPy solve_ivp"}


@app.post("/data/analyze")
def analyze_dataset(request: AnalyzeInput) -> dict[str, Any]:
    observations = request.observations
    x_values = np.asarray([row.x_value for row in observations], dtype=float)
    observed = np.asarray([row.observed_y for row in observations], dtype=float)
    if not np.all(np.isfinite(x_values)) or not np.all(np.isfinite(observed)):
        raise HTTPException(status_code=400, detail="All observations must be finite numbers.")
    if len(set(x_values.tolist())) != len(x_values):
        raise HTTPException(status_code=400, detail="Duplicate x-values are not supported; remove or combine repeated coordinates.")
    if request.model == "decay":
        basis = np.exp(-x_values)
        theoretical_model = "y = C·exp(−x)"
    elif request.model == "growth":
        basis = np.exp(2 * x_values)
        theoretical_model = "y = C·exp(2x)"
    else:
        basis = np.ones_like(x_values)
        theoretical_model = "y = x² + C"
    offset = x_values**2 if request.model == "quadratic" else np.zeros_like(x_values)
    parameter = float(np.dot(basis, observed - offset) / np.dot(basis, basis)) if request.fit_parameter else None
    prediction = basis * parameter + offset if parameter is not None else None
    theoretical = basis * request.known_parameter + offset if request.known_parameter is not None else None
    rows = []
    metrics: dict[str, float | None] = {"mse": None, "rmse": None, "mae": None, "r_squared": None}
    if parameter is not None:
        residuals = observed - prediction
        mse = float(np.mean(residuals**2))
        sse = float(np.sum(residuals**2))
        sst = float(np.sum((observed - np.mean(observed)) ** 2))
        metrics = {
            "mse": mse,
            "rmse": math.sqrt(mse),
            "mae": float(np.mean(np.abs(residuals))),
            "r_squared": float(1 - sse / sst) if sst > 0 else None,
        }
    if parameter is not None or theoretical is not None:
        for index, (x_value, actual) in enumerate(zip(x_values, observed, strict=True)):
            rows.append({
                "x_value": float(x_value),
                "observed_y": float(actual),
                "predicted_y": float(prediction[index]) if prediction is not None else None,
                "residual": float(actual - prediction[index]) if prediction is not None else None,
                "squared_residual": float((actual - prediction[index]) ** 2) if prediction is not None else None,
                "theoretical_y": float(theoretical[index]) if theoretical is not None else None,
            })
    note = f"Model: {theoretical_model}. A lower residual error describes fit to these observations; it does not establish physical validity."
    return {
        "model": request.model, "parameter_name": "C" if parameter is not None else None,
        "parameter_value": parameter, "rows": rows, "metrics": metrics,
        "note": note if parameter is not None else f"{note} Enable parameter fitting to calculate calibrated predictions and metrics.",
    }



def _predict_from_initial(m: sp.Expr, n: sp.Expr, x0: float, y0: float, xs: np.ndarray) -> np.ndarray:
    """Evaluate the single y(x) branch through (x0, y0), without extrapolating through failures."""
    m_fun = sp.lambdify((x, y), m, modules=["numpy"])
    n_fun = sp.lambdify((x, y), n, modules=["numpy"])

    def slope(t: float, state: np.ndarray) -> list[float]:
        with np.errstate(all="ignore"):
            numerator, denominator = float(m_fun(t, state[0])), float(n_fun(t, state[0]))
        if not np.isfinite(numerator) or not np.isfinite(denominator) or abs(denominator) < 1e-9:
            raise ValueError("ODE is singular on this solution branch.")
        result = -numerator / denominator
        if not np.isfinite(result) or abs(result) > 1e8:
            raise ValueError("ODE slope is invalid on this solution branch.")
        return [result]

    result = np.empty_like(xs)
    for side in (-1, 1):
        ids = [i for i, val in enumerate(xs) if (val < x0 if side == -1 else val > x0)]
        if not ids:
            continue
        ordered = sorted(ids, key=lambda i: abs(xs[i] - x0))
        targets = xs[ordered]
        try:
            sol = solve_ivp(slope, (x0, float(targets[-1])), [y0], t_eval=targets,
                            rtol=1e-7, atol=1e-9, max_step=max(abs(float(targets[-1]) - x0) / 80, 0.005))
        except (ValueError, OverflowError, TypeError, ZeroDivisionError) as exc:
            raise ValueError("Numerical solution encountered a singularity or invalid domain.") from exc
        if not sol.success or sol.y.shape[1] != len(targets):
            raise ValueError("Numerical solution did not reach all observations.")
        result[ordered] = sol.y[0]
    result[np.isclose(xs, x0, atol=1e-12, rtol=0)] = y0
    if not np.all(np.isfinite(result)):
        raise ValueError("Nonfinite model prediction.")
    return result


@app.post("/data/fit-ode")
def fit_ode_dataset(request: NumericalFitInput) -> dict[str, Any]:
    """Fit the initial value for a user-provided ODE; no fixed example family required."""
    m, n = _parsed(request.m, request.n)
    if sp.simplify(n) == 0:
        raise HTTPException(status_code=400, detail="N is zero; cannot evaluate dy/dx = -M/N.")
    xs = np.array([row.x_value for row in request.observations], dtype=float)
    actual = np.array([row.observed_y for row in request.observations], dtype=float)
    if not np.all(np.isfinite(xs)) or not np.all(np.isfinite(actual)) or not math.isfinite(request.x0) or not math.isfinite(request.initial_guess):
        raise HTTPException(status_code=400, detail="Input values must be finite.")
    if len(set(xs.tolist())) != len(xs):
        raise HTTPException(status_code=400, detail="Duplicate x coordinates are not supported.")
    if np.max(np.abs(xs - request.x0)) > 100:
        raise HTTPException(status_code=400, detail="Observations must be within 100 x-units of x0.")

    def residual(parameter: np.ndarray) -> np.ndarray:
        try:
            return _predict_from_initial(m, n, request.x0, float(parameter[0]), xs) - actual
        except (ValueError, OverflowError):
            return np.full(len(xs), 1e9)

    try:
        optimized = least_squares(residual, [request.initial_guess], bounds=(-1e5, 1e5), max_nfev=90)
        y0_fit = float(optimized.x[0])
        predictions = _predict_from_initial(m, n, request.x0, y0_fit, xs)
    except (ValueError, OverflowError) as exc:
        raise HTTPException(status_code=422, detail=f"Could not fit a valid numerical solution: {exc}") from exc
    if not optimized.success or not np.all(np.isfinite(predictions)) or np.max(np.abs(predictions - actual)) >= 1e8:
        raise HTTPException(status_code=422, detail="Could not obtain a reliable numerical fit on this domain.")
    errors = actual - predictions
    mse = float(np.mean(errors**2))
    sst = float(np.sum((actual - actual.mean())**2))
    sse = float(np.sum(errors**2))
    return {
        "model": "numerical_ode", "parameter_name": "y0", "parameter_value": y0_fit,
        "rows": [
            {"x_value": float(t), "observed_y": float(obs), "predicted_y": float(pred),
             "residual": float(err), "squared_residual": float(err**2)}
            for t, obs, pred, err in zip(xs, actual, predictions, errors, strict=True)
        ],
        "metrics": {"mse": mse, "rmse": math.sqrt(mse), "mae": float(np.mean(np.abs(errors))),
                    "r_squared": 1 - sse/sst if sst > 0 else None},
        "note": f"Numerical fit for M dx + N dy = 0, estimating y({request.x0}) via SciPy. This is a local least-squares fit of one regular solution branch; it does not prove the model is physically valid.",
    }


def _read_dataset(filename: str) -> list[dict[str, float | str]]:
    with (_DATA_DIR / filename).open(newline="", encoding="utf-8") as file:
        reader = csv.DictReader(file)
        required = {"case_id", "x_value", "observed_y"}
        if not reader.fieldnames or not required.issubset(set(reader.fieldnames)):
            raise RuntimeError(f"Demo dataset {filename} is missing required CSV columns.")
        return [
            {"case_id": row["case_id"], "x_value": float(row["x_value"]), "observed_y": float(row["observed_y"])}
            for row in reader
        ]


@app.get("/examples")
def get_examples() -> dict[str, Any]:
    examples = [
        {"id": "exact-polynomial", "title": "Exact polynomial", "m": "2*x*y + 3", "n": "x**2 + 4*y", "kind": "exact", "expected_solution": "x²y + 3x + 2y² = C", "description": "A direct exactness check with a polynomial potential."},
        {"id": "exact-product", "title": "Exact product", "m": "y", "n": "x", "kind": "exact", "expected_solution": "xy = C", "description": "The simplest mixed partials example."},
        {"id": "factor-x", "title": "Integrating factor μ(x)", "m": "y", "n": "x**2", "kind": "integrating_factor_x", "expected_solution": "μ(x) = exp(-1/x)/x²", "description": "The one-variable test identifies an integrating factor in x."},
        {"id": "factor-y", "title": "Integrating factor μ(y)", "m": "y**2", "n": "x*y", "kind": "integrating_factor_y", "expected_solution": "xy = C", "description": "The factor μ(y)=1/y is valid on intervals with y ≠ 0."},
        {"id": "unsupported", "title": "Unsupported simple factor", "m": "x + y", "n": "1 + x*y", "kind": "unsupported", "expected_solution": "No supported one-variable factor identified", "description": "Neither supported one-variable integrating-factor test succeeds."},
    ]
    datasets = [
        {"id": "decay-noise", "title": "Linear solution with noise", "model": "decay", "equation": "dy/dx = −y", "true_parameter": 2.0, "synthetic": True, "observations": _read_dataset("decay-noise.csv")},
        {"id": "quadratic-sample", "title": "Polynomial solution", "model": "quadratic", "equation": "dy/dx = 2x", "true_parameter": 1.0, "synthetic": True, "observations": _read_dataset("quadratic-sample.csv")},
        {"id": "growth-sample", "title": "Exponential growth", "model": "growth", "equation": "dy/dx = 2y", "true_parameter": 0.75, "synthetic": True, "observations": _read_dataset("growth-sample.csv")},
    ]
    return {"examples": examples, "datasets": datasets}
