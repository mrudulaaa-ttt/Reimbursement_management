import json
import math
import sys
from datetime import datetime

import mysql.connector
import numpy as np
from sklearn.ensemble import IsolationForest


def safe_date_to_ordinal(value):
    if not value:
        return 0
    if isinstance(value, datetime):
        return value.date().toordinal()
    if hasattr(value, "toordinal"):
        return value.toordinal()
    try:
        return datetime.fromisoformat(str(value)).date().toordinal()
    except ValueError:
        return 0


def load_payload():
    raw = sys.stdin.read().strip()
    if not raw:
      raise ValueError("No payload received")
    return json.loads(raw)


def fetch_history(connection, company_id):
    query = """
        SELECT
            c.id,
            c.employee_user_id,
            c.category_id,
            c.converted_amount,
            c.expense_date,
            c.risk_score,
            IFNULL(a.duplicate_flag, 0) AS duplicate_flag,
            IFNULL(a.shared_bill_flag, 0) AS shared_bill_flag,
            IFNULL(a.amount_mismatch_flag, 0) AS amount_mismatch_flag,
            IFNULL(a.unusual_flag, 0) AS unusual_flag
        FROM claims c
        JOIN users u ON u.id = c.employee_user_id
        LEFT JOIN ai_audits a ON a.claim_id = c.id
        WHERE u.company_id = %s
    """
    with connection.cursor(dictionary=True) as cursor:
        cursor.execute(query, (company_id,))
        return cursor.fetchall()


def build_feature_vector(row):
    expense_day = safe_date_to_ordinal(row.get("expense_date"))
    converted_amount = float(row.get("converted_amount") or 0)
    category_id = float(row.get("category_id") or 0)
    risk_score = float(row.get("risk_score") or 0)
    duplicate_flag = float(row.get("duplicate_flag") or 0)
    shared_bill_flag = float(row.get("shared_bill_flag") or 0)
    mismatch_flag = float(row.get("amount_mismatch_flag") or 0)
    unusual_flag = float(row.get("unusual_flag") or 0)
    return [
        converted_amount,
        category_id,
        expense_day,
        risk_score,
        duplicate_flag,
        shared_bill_flag,
        mismatch_flag,
        unusual_flag,
    ]


def score_candidate(history_rows, candidate_row):
    if len(history_rows) < 4:
        return {
            "available": False,
            "anomaly_score": None,
            "is_anomaly": False,
            "message": "Insufficient historical expenses for anomaly model",
        }

    feature_matrix = np.array([build_feature_vector(row) for row in history_rows], dtype=float)
    model = IsolationForest(
        n_estimators=150,
        contamination=0.12,
        random_state=42,
    )
    model.fit(feature_matrix)

    candidate_vector = np.array([build_feature_vector(candidate_row)], dtype=float)
    raw_score = float(model.decision_function(candidate_vector)[0])
    prediction = int(model.predict(candidate_vector)[0])
    confidence = max(0.0, min(99.99, abs(raw_score) * 100))

    return {
        "available": True,
        "anomaly_score": round(confidence, 2),
        "is_anomaly": prediction == -1,
        "message": "Isolation Forest detected the claim as unusual"
        if prediction == -1
        else "Claim fits historical expense behavior",
    }


def main():
    payload = load_payload()
    db_config = payload["db"]
    company_id = payload["candidate"]["company_id"]

    connection = mysql.connector.connect(
        host=db_config["host"],
        port=db_config["port"],
        user=db_config["user"],
        password=db_config["password"],
        database=db_config["database"],
    )

    try:
        history_rows = fetch_history(connection, company_id)
        result = score_candidate(history_rows, payload["candidate"])
        print(json.dumps(result))
    finally:
        connection.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({
            "available": False,
            "anomaly_score": None,
            "is_anomaly": False,
            "message": str(error),
        }))
