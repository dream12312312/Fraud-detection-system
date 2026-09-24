"""SentinelPay transaction simulator.

Generates normal and fraudulent transactions through the Core API so the full
pipeline (API -> fraud engine -> notifications -> admin dashboard) can be tested.

Usage:
  python sim.py --register --normal 20 --fraud 10
  python sim.py --loop            # continuous traffic
"""
import argparse
import random
import string
import time
import httpx

API = "http://localhost:4000"
COUNTRIES = ["US", "US", "US", "CA", "GB", "FR", "BR", "NG"]
MERCHANTS = ["Grocery Store", "Coffee Shop", "Online Retailer", "Gas Station", "Streaming Service", "Pharmacy"]


def make_user(client: httpx.Client, idx: int) -> dict:
    email = f"user{idx}_{random.randint(1000, 9999)}@sim.local"
    password = "Simulator123!"
    r = client.post(f"{API}/api/v1/auth/register", json={
        "email": email, "password": password, "fullName": f"Sim User {idx}"
    })
    r.raise_for_status()
    login = client.post(f"{API}/api/v1/auth/login", json={"email": email, "password": password}).json()
    token = login["accessToken"]
    user_id = login["user"]["id"]
    headers = {"Authorization": f"Bearer {token}"}
    # give the simulated user a starting balance by topping up via seed account
    client.post(f"{API}/api/v1/transfer", headers=headers, json={
        "toAccount": "SIM-DEPOSIT", "amount": 1
    })
    return {"token": token, "headers": headers, "user_id": user_id, "email": email}


def normal_transaction(u: dict, i: int) -> dict:
    body = {
        "toAccount": f"MERCH-{''.join(random.choices(string.ascii_uppercase, k=3))}-{random.randint(100, 999)}",
        "amount": round(random.uniform(2, 120), 2),
        "merchant": random.choice(MERCHANTS),
        "country": "US",
        "device": "web"
    }
    r = httpx.post(f"{API}/api/v1/transfer", headers=u["headers"], json=body, timeout=10)
    return r.json()


def fraud_transaction(u: dict, i: int) -> dict:
    scenario = random.choice(["large_transfer", "foreign_country", "night_drain", "new_beneficiary_drain"])
    body = {
        "large_transfer": {"toAccount": f"UNKNOWN-{random.randint(100000, 999999)}", "amount": round(random.uniform(9500, 24000), 2), "country": "US"},
        "foreign_country": {"toAccount": f"MERCH-EXT-{random.randint(100, 999)}", "amount": round(random.uniform(1500, 6000), 2), "country": random.choice(["NG", "BR", "RU"]), "merchant": "Foreign Merchant"},
        "night_drain": {"toAccount": f"UNKNOWN-{random.randint(100000, 999999)}", "amount": round(random.uniform(3000, 9000), 2), "country": "US"},
        "new_beneficiary_drain": {"toAccount": f"NEW-{random.randint(100000, 999999)}", "amount": round(random.uniform(6000, 12000), 2), "country": "US"},
    }[scenario]
    body["device"] = random.choice(["emulator", "rooted-device", "unknown"])
    r = httpx.post(f"{API}/api/v1/transfer", headers=u["headers"], json=body, timeout=10)
    return r.json()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--normal", type=int, default=10)
    ap.add_argument("--fraud", type=int, default=5)
    ap.add_argument("--users", type=int, default=3)
    ap.add_argument("--loop", action="store_true")
    ap.add_argument("--register", action="store_true", help="create fresh simulator users")
    args = ap.parse_args()

    users = []
    with httpx.Client() as client:
        for i in range(args.users):
            users.append(make_user(client, i))
    print(f"[sim] {len(users)} simulator users ready")

    results = []
    rnd = 0
    while True:
        rnd += 1
        for kind, fn, count in (("normal", normal_transaction, args.normal), ("fraud", fraud_transaction, args.fraud)):
            for i in range(count):
                u = random.choice(users)
                try:
                    resp = fn(u, i)
                    status = resp.get("status", resp.get("error", "?"))
                    results.append((kind, resp.get("txId", "-"), status, resp.get("fraudProbability")))
                    print(f"[sim] {kind:6s} {resp.get('txId','-')} -> {status} p={resp.get('fraudProbability')}")
                except Exception as e:
                    print(f"[sim] error: {e}")
                time.sleep(random.uniform(0.05, 0.3))
        blocked = sum(1 for r in results if r[2] == "BLOCKED")
        completed = sum(1 for r in results if r[2] == "COMPLETED")
        challenged = sum(1 for r in results if r[2] == "CHALLENGED")
        print(f"[sim] round {rnd}: completed={completed} challenged={challenged} blocked={blocked}")
        if not args.loop:
            break
        time.sleep(5)


if __name__ == "__main__":
    main()
