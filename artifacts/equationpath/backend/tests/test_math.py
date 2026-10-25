import unittest
import math

from app.main import (
    AnalyzeInput,
    Observation,
    analyze_dataset,
    NumericalFitInput,
    fit_ode_dataset,
    exactness,
    parse_expression,
    plot_equation,
    solve,
)


class EquationPathMathTests(unittest.TestCase):
    def test_exact_polynomial_solution_is_verified(self) -> None:
        result = solve(parse_expression("2*x*y + 3"), parse_expression("x**2 + 4*y"))
        self.assertEqual(result["status"], "solved")
        self.assertEqual(result["implicit_solution"], "x**2*y + 3*x + 2*y**2 = C")
        self.assertEqual(result["verification"], {"F_x_equals_M": True, "F_y_equals_N": True})

    def test_supported_integrating_factors_are_detected_and_verified(self) -> None:
        cases = [
            ("y", "x**2", "integrating_factor_x", "y*exp(-1/x) = C"),
            ("y**2", "x*y", "integrating_factor_y", "x*y = C"),
        ]
        for m_text, n_text, expected_method, expected_solution in cases:
            with self.subTest(method=expected_method):
                m, n = parse_expression(m_text), parse_expression(n_text)
                self.assertEqual(exactness(m, n)["method"], expected_method)
                result = solve(m, n)
                self.assertEqual(result["status"], "solved")
                self.assertEqual(result["implicit_solution"], expected_solution)
                self.assertTrue(all(result["verification"].values()))

    def test_unsupported_factor_is_reported_without_claiming_no_solution(self) -> None:
        result = solve(parse_expression("x + y"), parse_expression("1 + x*y"))
        self.assertEqual(result["status"], "unsupported")
        self.assertIsNone(result["potential"])
        self.assertIn("not exact", result["steps"][0])

    def test_parser_rejects_python_code(self) -> None:
        with self.assertRaises(ValueError):
            parse_expression("__import__('os').system('echo unsafe')")

    def test_numerical_plot_matches_exponential_decay(self) -> None:
        result = plot_equation(
            type("Request", (), {
                "m": "y", "n": "1", "x0": 0.0, "y0": 1.0,
                "x_min": -1.0, "x_max": 1.0, "points": 120,
            })()
        )
        self.assertGreater(len(result["x"]), 50)
        nearest = min(range(len(result["x"])), key=lambda index: abs(result["x"][index] - 1.0))
        self.assertAlmostEqual(result["y"][nearest], math.exp(-1), delta=1e-5)

    def test_fit_metrics_and_parameter_estimate(self) -> None:
        result = analyze_dataset(AnalyzeInput(
            model="quadratic",
            observations=[
                Observation(x_value=-2, observed_y=5.02),
                Observation(x_value=-1, observed_y=1.99),
                Observation(x_value=0, observed_y=1.01),
                Observation(x_value=1, observed_y=2.02),
                Observation(x_value=2, observed_y=4.98),
            ],
        ))
        self.assertAlmostEqual(result["parameter_value"], 1.004, delta=0.02)
        self.assertGreaterEqual(result["metrics"]["rmse"], 0)
        self.assertEqual(len(result["rows"]), 5)

    def test_two_exact_examples(self) -> None:
        for m_text, n_text in [("2*x*y + 3", "x**2 + 4*y"), ("y", "x")]:
            m, n = parse_expression(m_text), parse_expression(n_text)
            self.assertTrue(exactness(m, n)["is_exact"])
            result = solve(m, n)
            self.assertEqual(result["status"], "solved")
            self.assertTrue(all(result["verification"].values()))

    def test_zero_variance_r_squared_is_undefined(self) -> None:
        result = analyze_dataset(AnalyzeInput(
            model="quadratic",
            observations=[
                Observation(x_value=0, observed_y=4),
                Observation(x_value=1, observed_y=4),
                Observation(x_value=2, observed_y=4),
            ],
        ))
        self.assertIsNone(result["metrics"]["r_squared"])

    def test_duplicate_observations_are_rejected(self) -> None:
        from fastapi import HTTPException
        with self.assertRaises(HTTPException):
            analyze_dataset(AnalyzeInput(
                model="decay",
                observations=[
                    Observation(x_value=1, observed_y=1),
                    Observation(x_value=1, observed_y=2),
                ],
            ))

    def test_numerical_fit_recovers_decay_initial_value(self) -> None:
        observations = [
            Observation(x_value=0.25*i, observed_y=2.5*math.exp(-0.25*i))
            for i in range(9)
        ]
        result = fit_ode_dataset(NumericalFitInput(
            m="y", n="1", observations=observations, x0=0, initial_guess=1
        ))
        self.assertAlmostEqual(result["parameter_value"], 2.5, delta=1e-3)
        self.assertLess(result["metrics"]["rmse"], 1e-4)

    def test_numerical_fit_rejects_duplicate_x_coordinates(self) -> None:
        from fastapi import HTTPException
        with self.assertRaises(HTTPException):
            fit_ode_dataset(NumericalFitInput(
                m="y", n="1",
                observations=[
                    Observation(x_value=0, observed_y=2),
                    Observation(x_value=0, observed_y=2),
                    Observation(x_value=1, observed_y=1),
                ]
            ))


if __name__ == "__main__":
    unittest.main()
