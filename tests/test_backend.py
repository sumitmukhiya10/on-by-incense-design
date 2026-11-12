import json
import io
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import server


class StoreBackendFlowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.temp_root = Path(self.temp.name)
        self.data_dir = self.temp_root / "json"
        self.image_dir = self.temp_root / "images"
        self.data_dir.mkdir()
        isolated_data = {
            "products": [],
            "settings": {},
            "discounts": {},
            "orders": {"records": []},
            "enquiries": {"records": []},
            "images": {"records": []},
        }
        for name in ("products", "settings", "discounts", "orders", "enquiries", "images"):
            (self.data_dir / f"{name}.json").write_text(json.dumps(isolated_data[name]), encoding="utf-8")
        (self.data_dir / "admin.json").write_text(json.dumps({"initialized": False, "password_hash": "", "recovery_hash": "", "master_password_hash": ""}), encoding="utf-8")
        self.originals = {
            "DATA_DIR": server.DATA_DIR,
            "IMAGE_DIR": server.IMAGE_DIR,
            "PRODUCT_IMAGE_DIR": server.PRODUCT_IMAGE_DIR,
            "HOMEPAGE_IMAGE_DIR": server.HOMEPAGE_IMAGE_DIR,
        }
        self.uploaded = []
        self.patches = [
            patch.object(server, "DATA_DIR", self.data_dir),
            patch.object(server, "IMAGE_DIR", self.image_dir),
            patch.object(server, "PRODUCT_IMAGE_DIR", self.image_dir / "products"),
            patch.object(server, "HOMEPAGE_IMAGE_DIR", self.image_dir / "homepage"),
        ]
        for item in self.patches:
            item.start()
        self.client_context = TestClient(server.app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000))
        with redirect_stdout(io.StringIO()), patch("builtins.print"):
            self.client = self.client_context.__enter__()

    def tearDown(self):
        self.client_context.__exit__(None, None, None)
        for item in self.patches:
            item.stop()
        for path in self.uploaded:
            path.unlink(missing_ok=True)
        for name, value in self.originals.items():
            setattr(server, name, value)
        self.temp.cleanup()

    def upload(self, kind="product"):
        fake_jpeg = b"\xff\xd8\xff\xe0" + b"0" * 16
        response = self.client.post("/api/admin/upload-image", data={"kind": kind}, files={"file": ("chair.jpg", fake_jpeg, "image/jpeg")})
        self.assertEqual(response.status_code, 200, response.text)
        url = response.json()["url"]
        self.uploaded.append(server.IMAGE_DIR / url.split("?", 1)[0].removeprefix("/images/"))
        return url

    def set_up_admin(self):
        with redirect_stdout(io.StringIO()):
            response = self.client.post("/api/admin/setup", json={"password": "Strong Password 123!", "master_password": "Master Recovery 456!"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["recovery_code"])
        self.assertIn("httponly", response.headers.get("set-cookie", "").lower())
        return response.json()["recovery_code"]

    def test_complete_customer_and_admin_flow(self):
        self.assertEqual(self.client.get("/api/health").json(), {"status": "ok"})
        self.assertEqual(self.client.get("/").status_code, 200)
        self.assertEqual(self.client.get("/shop.html").status_code, 200)
        self.assertEqual(self.client.get("/js/main.js").status_code, 200)
        self.assertIn("text/javascript", self.client.get("/js/main.js").headers.get("content-type", ""))
        for page in ("product.html", "cart.html", "checkout.html", "contact.html", "confirmation.html", "about.html"):
            page_response = self.client.get(f"/{page}")
            self.assertEqual(page_response.status_code, 200)
            self.assertIn('/js/main.js', page_response.text, f"{page} must load the storefront JavaScript")
        admin_html = self.client.get("/admin.html").text
        self.assertIn('href="/"', admin_html)
        self.assertIn("View Website", admin_html)
        initial_catalog = self.client.get("/api/products")
        self.assertEqual(initial_catalog.status_code, 200)
        self.assertEqual(initial_catalog.json(), [])
        self.assertEqual(self.client.get("/api/admin/products").status_code, 401)
        with patch("builtins.print"), TestClient(server.app, base_url="http://127.0.0.1", client=("192.0.2.10", 50001)) as remote_client:
            self.assertEqual(remote_client.post("/api/admin/setup", json={"password": "Strong Password 123!"}).status_code, 403)
        self.assertEqual(self.client.get("/json/products.json").status_code, 404)
        self.assertEqual(self.client.get("/data/admin.json").status_code, 404)

        recovery = self.set_up_admin()
        saved_master = json.loads((self.data_dir / "admin.json").read_text(encoding="utf-8"))["master_password_hash"]
        self.assertTrue(saved_master.startswith("pbkdf2_sha256$"))
        self.assertNotIn("Master Recovery 456!", (self.data_dir / "admin.json").read_text(encoding="utf-8"))
        self.assertEqual(self.client.post("/api/admin/recovery-password", json={"current_password": "wrong", "master_password": "Updated Master 567!"}).status_code, 400)
        master_update = self.client.post("/api/admin/recovery-password", json={"current_password": "Strong Password 123!", "master_password": "Updated Master 567!"})
        self.assertEqual(master_update.status_code, 200, master_update.text)
        self.assertEqual(self.client.post("/api/admin/login", json={"password": "incorrect"}).status_code, 401)
        admin_list = self.client.get("/api/admin/products")
        self.assertEqual(admin_list.status_code, 200, admin_list.text)

        old_image_index = json.loads((self.data_dir / "images.json").read_text(encoding="utf-8"))
        product_photo = self.upload()
        updated_image_index = json.loads((self.data_dir / "images.json").read_text(encoding="utf-8"))
        if isinstance(old_image_index, list):
            self.assertEqual(updated_image_index[:-1], old_image_index)
        self.assertGreaterEqual(len(updated_image_index), len(old_image_index))
        product = {
            "name": "Test Oak Chair", "category": "Chairs", "price_paise": 250000,
            "sale_price_paise": None, "sale_active": False,
            "description": "Test furniture", "images": [product_photo],
            "availability_confirmed": True, "in_stock": True, "active": True,
            "featured": True, "bestseller": False, "new_arrival": True,
            "discount_eligible": True,
        }
        added = self.client.post("/api/admin/products", json=product)
        self.assertEqual(added.status_code, 200, added.text)
        product_id = added.json()["id"]
        self.assertEqual(self.client.get("/api/products/test-oak-chair").status_code, 200)
        self.assertEqual(self.client.get(product_photo.split("?", 1)[0]).status_code, 200)

        updated = {**added.json(), "price_paise": 275000}
        self.assertEqual(self.client.put(f"/api/admin/products/{product_id}", json=updated).json()["price_paise"], 275000)
        self.assertEqual(self.client.get("/api/products/test-oak-chair").json()["price_paise"], 275000)
        drive_image = "https://drive.google.com/thumbnail?id=TestDriveImageID123&sz=w1200"
        linked_product = {**updated, "images": [drive_image]}
        linked = self.client.put(f"/api/admin/products/{product_id}", json=linked_product)
        self.assertEqual(linked.status_code, 200, linked.text)
        self.assertEqual(linked.json()["images"], [drive_image])
        invalid_link = self.client.put(f"/api/admin/products/{product_id}", json={**linked_product, "images": ["http://example.com/chair.jpg"]})
        self.assertEqual(invalid_link.status_code, 400)
        self.assertEqual(self.client.put(f"/api/admin/products/{product_id}", json=updated).status_code, 200)

        homepage_photo = self.upload("homepage")
        settings = self.client.get("/api/admin/settings").json()
        settings.update({"homepage_heading": "A Better Chair", "hero_image": homepage_photo.split("?", 1)[0]})
        saved_settings = self.client.put("/api/admin/settings", json=settings)
        self.assertEqual(saved_settings.status_code, 200, saved_settings.text)
        self.assertEqual(self.client.get("/api/settings").json()["hero_image"], homepage_photo.split("?", 1)[0])

        discounts = self.client.get("/api/discounts").json()
        discounts["tiers"] = [{"min_items": 1, "percent": 0}, {"min_items": 2, "percent": 5}]
        discounts["discounts_enabled"] = True
        discounts["max_discount_percent"] = 15
        self.assertEqual(self.client.put("/api/admin/discounts", json=discounts).status_code, 200)
        quote = self.client.post("/api/cart/quote", json={"items": [{"product_id": product_id, "quantity": 2}]})
        self.assertEqual(quote.status_code, 200)
        self.assertEqual(quote.json()["total_paise"], 522500)
        self.assertEqual(quote.json()["lines"][0]["name"], "Test Oak Chair")
        self.assertEqual(quote.json()["lines"][0]["quantity"], 2)

        unavailable_product = {**updated, "in_stock": False}
        self.assertEqual(self.client.put(f"/api/admin/products/{product_id}", json=unavailable_product).status_code, 200)
        unavailable_quote = self.client.post("/api/cart/quote", json={"items": [{"product_id": product_id, "quantity": 1}]})
        self.assertEqual(unavailable_quote.status_code, 400)
        self.assertIn("unavailable", unavailable_quote.json()["detail"].lower())
        self.assertEqual(self.client.put(f"/api/admin/products/{product_id}", json=updated).status_code, 200)

        order = self.client.post("/api/orders", json={"items": [{"product_id": product_id, "quantity": 1}], "customer": {"name": "Test Customer", "phone": "+91 90000 00000", "address": "Test Street", "city": "Delhi", "state": "Delhi"}})
        self.assertEqual(order.status_code, 200, order.text)
        self.assertTrue(order.json()["whatsapp_url"].startswith("https://wa.me/919217299927?"))
        self.assertEqual(order.json()["quote"]["lines"][0]["name"], "Test Oak Chair")
        self.assertEqual(order.json()["quote"]["lines"][0]["quantity"], 1)
        self.assertEqual(order.json()["quote"]["total_paise"], 275000)
        from urllib.parse import parse_qs, urlsplit
        whatsapp_text = parse_qs(urlsplit(order.json()["whatsapp_url"]).query)["text"][0]
        self.assertIn("Test Oak Chair x 1 - INR 2,750.00", whatsapp_text)
        self.assertIn("Estimated total: INR 2,750.00", whatsapp_text)
        self.assertEqual(self.client.get("/api/admin/orders").json()[0]["id"], order.json()["id"])

        enquiry = self.client.post("/api/enquiries", json={"name": "Test Customer", "phone": "+91 90000 00000", "email": "customer@example.com", "subject": "Chair", "message": "Is this in stock?"})
        self.assertEqual(enquiry.status_code, 200, enquiry.text)
        self.assertIn("wa.me", enquiry.json()["whatsapp_url"])
        self.assertEqual(self.client.get("/api/admin/enquiries").json()[0]["id"], enquiry.json()["id"])
        for number in range(20):
            created = self.client.post("/api/enquiries", json={"name": f"Customer {number}", "phone": "9000000000", "message": "Another furniture question"})
            self.assertEqual(created.status_code, 200)
        first_page = self.client.get("/api/admin/enquiries/page?per_page=20&page=1")
        second_page = self.client.get("/api/admin/enquiries/page?per_page=20&page=2")
        self.assertEqual(first_page.json()["total"], 21)
        self.assertEqual(len(first_page.json()["records"]), 20)
        self.assertEqual(len(second_page.json()["records"]), 1)
        self.assertEqual(self.client.get("/api/admin/enquiries/page?per_page=100").status_code, 422)
        self.assertEqual(self.client.get("/api/admin/enquiries/page?status=Replied").json()["total"], 0)
        self.assertEqual(self.client.get("/api/admin/enquiries/page?date_range=older").json()["total"], 0)
        archived = self.client.put(f"/api/admin/enquiries/{enquiry.json()['id']}", json={"action": "archive"})
        self.assertTrue(archived.json()["archived"])
        self.assertEqual(self.client.get("/api/admin/enquiries/page?archived=true").json()["total"], 1)
        restored = self.client.put(f"/api/admin/enquiries/{enquiry.json()['id']}", json={"action": "restore"})
        self.assertFalse(restored.json()["archived"])

        data_file = self.data_dir / "products.json"
        self.assertTrue(data_file.exists())
        self.assertEqual(json.loads(data_file.read_text(encoding="utf-8"))[0]["name"], "Test Oak Chair")

        self.assertEqual(self.client.post("/api/admin/change-password", json={"current_password": "wrong", "new_password": "Changed Password 456!"}).status_code, 400)
        changed = self.client.post("/api/admin/change-password", json={"current_password": "Strong Password 123!", "new_password": "Changed Password 456!"})
        self.assertEqual(changed.status_code, 200, changed.text)
        self.client.post("/api/admin/logout")
        self.assertEqual(self.client.post("/api/admin/login", json={"password": "Strong Password 123!"}).status_code, 401)
        self.assertEqual(self.client.post("/api/admin/login", json={"password": "Changed Password 456!"}).status_code, 200)
        self.client.post("/api/admin/logout")

        recovery_result = self.client.post("/api/admin/recover", json={"recovery_code": recovery, "new_password": "Recovered Password 789!"})
        self.assertEqual(recovery_result.status_code, 200, recovery_result.text)
        self.assertNotEqual(recovery_result.json()["recovery_code"], recovery)
        self.client.post("/api/admin/logout")
        self.assertEqual(self.client.post("/api/admin/recover", json={"recovery_code": recovery, "new_password": "Another Password 890!"}).status_code, 400)
        persistent_recovery = self.client.post("/api/admin/recover", json={"recovery_password": "Updated Master 567!", "new_password": "Master Reset Password 567!"})
        self.assertEqual(persistent_recovery.status_code, 200, persistent_recovery.text)
        self.assertTrue(persistent_recovery.json()["recovered_with_master_password"])
        self.assertEqual(persistent_recovery.json()["recovery_code"], "")
        self.client.post("/api/admin/logout")
        repeated_recovery = self.client.post("/api/admin/recover", json={"recovery_password": "Updated Master 567!", "new_password": "Final Admin Password 678!"})
        self.assertEqual(repeated_recovery.status_code, 200, repeated_recovery.text)
        self.assertTrue(repeated_recovery.json()["recovered_with_master_password"])
        self.client.post("/api/admin/logout")
        self.assertEqual(self.client.post("/api/admin/login", json={"password": "Master Reset Password 567!"}).status_code, 401)
        self.assertEqual(self.client.post("/api/admin/login", json={"password": "Final Admin Password 678!"}).status_code, 200)

        deleted = self.client.delete(f"/api/admin/products/{product_id}")
        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertEqual(self.client.get("/api/products/test-oak-chair").status_code, 404)
        deleted_quote = self.client.post("/api/cart/quote", json={"items": [{"product_id": product_id, "quantity": 1}]})
        self.assertEqual(deleted_quote.status_code, 400)
        self.assertEqual(self.client.delete(f"/api/admin/orders/{order.json()['id']}").status_code, 200)
        self.assertEqual(self.client.get("/api/admin/orders").json(), [])
        self.assertEqual(self.client.delete(f"/api/admin/orders/{order.json()['id']}").status_code, 404)
        self.assertEqual(self.client.delete(f"/api/admin/enquiries/{enquiry.json()['id']}").status_code, 200)
        self.assertEqual(self.client.delete(f"/api/admin/enquiries/{enquiry.json()['id']}").status_code, 404)
        self.assertTrue(self.uploaded[0].exists(), "Deleting a product must leave its uploaded photo intact.")

    def test_environment_reset_updates_only_admin_once_and_preserves_recovery(self):
        self.set_up_admin()
        sentinels = {
            "products": [{"id": 81, "name": "Saved Chair"}],
            "settings": {"business_name": "Saved Store"},
            "discounts": {"tiers": [{"min_items": 2, "percent": 5}]},
            "orders": {"records": [{"id": "TEST-ORDER", "customer_name": "Fixture Customer"}]},
            "enquiries": {"records": [{"id": "TEST-MESSAGE", "message": "Fixture enquiry"}]},
            "images": {"records": [{"path": "/images/products/fixture.jpg"}]},
        }
        for name, value in sentinels.items():
            server.write_json(name, value)
        saved_data = {name: server.read_json(name) for name in sentinels}
        original_admin_hash = server.admin_data()["password_hash"]
        new_password = "Railway Admin Password 123!"
        new_master = "Railway Master Password 456!"
        reset_env = {
            "RESET_ADMIN_FROM_ENV": "true",
            "INITIAL_ADMIN_PASSWORD": new_password,
            "INITIAL_MASTER_PASSWORD": new_master,
        }

        with patch.dict(os.environ, reset_env):
            with patch.dict(os.environ, {"INITIAL_MASTER_PASSWORD": ""}):
                with self.assertRaises(RuntimeError):
                    server.initialize_admin_from_environment()
            self.assertEqual(server.admin_data()["password_hash"], original_admin_hash)

            self.assertEqual(self.client.get("/api/admin/products").status_code, 200)
            server.initialize_admin_from_environment()
            self.assertTrue(server.admin_data()["environment_reset_applied"])
            self.assertEqual(self.client.get("/api/admin/products").status_code, 401)
            self.assertEqual(self.client.post("/api/admin/login", json={"password": "Strong Password 123!"}).status_code, 401)
            self.assertEqual(self.client.post("/api/admin/login", json={"password": new_password}).status_code, 200)
            self.assertEqual(self.client.post("/api/admin/recover", json={"recovery_password": "Master Recovery 456!", "new_password": "Wrong Master Reset 567!"}).status_code, 400)

            recovered = self.client.post("/api/admin/recover", json={"recovery_password": new_master, "new_password": "Recovered Railway Admin 789!"})
            self.assertEqual(recovered.status_code, 200, recovered.text)
            self.assertTrue(recovered.json()["recovered_with_master_password"])

            os.environ["INITIAL_ADMIN_PASSWORD"] = "Ignored Replacement Admin 234!"
            os.environ["INITIAL_MASTER_PASSWORD"] = "Ignored Replacement Master 567!"
            server.initialize_admin_from_environment()
            self.client.post("/api/admin/logout")
            self.assertEqual(self.client.post("/api/admin/login", json={"password": "Recovered Railway Admin 789!"}).status_code, 200)
            self.assertEqual(self.client.post("/api/admin/login", json={"password": "Ignored Replacement Admin 234!"}).status_code, 401)

            current_hash = server.admin_data()["password_hash"]
            os.environ["RESET_ADMIN_FROM_ENV"] = "false"
            server.initialize_admin_from_environment()
            self.assertNotIn("environment_reset_applied", server.admin_data())
            self.assertEqual(server.admin_data()["password_hash"], current_hash)
            os.environ.pop("RESET_ADMIN_FROM_ENV")
            os.environ["INITIAL_ADMIN_PASSWORD"] = "Another Ignored Admin 345!"
            os.environ["INITIAL_MASTER_PASSWORD"] = "Another Ignored Master 678!"
            server.initialize_admin_from_environment()
            self.assertEqual(server.admin_data()["password_hash"], current_hash)

        self.assertEqual({name: server.read_json(name) for name in sentinels}, saved_data)


class RailwayStorageTests(unittest.TestCase):
    def test_volume_seeds_are_copied_once_and_images_keep_stable_urls(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            seed_dir = root / "safe-seeds"
            source_images = root / "bundled-images"
            storage = root / "volume"
            data_dir = storage / "json"
            image_dir = storage / "images"
            (seed_dir / "products.json").parent.mkdir(parents=True)
            (seed_dir / "products.json").write_text(json.dumps([{"id": 1, "name": "Seed Chair"}]), encoding="utf-8")
            (seed_dir / "settings.json").write_text(json.dumps({"business_name": "Seed Store"}), encoding="utf-8")
            (seed_dir / "discounts.json").write_text(json.dumps({"tiers": []}), encoding="utf-8")
            image_source = source_images / "products" / "oak-chair.jpg"
            image_source.parent.mkdir(parents=True)
            image_source.write_bytes(b"original-photo")

            environment = {
                "APP_ENV": "production",
                "STORAGE_DIR": str(storage),
                "RAILWAY_VOLUME_MOUNT_PATH": str(storage),
                "SESSION_SECRET": "S" * 48,
                "INITIAL_ADMIN_PASSWORD": "Production Admin 123!",
                "INITIAL_MASTER_PASSWORD": "Production Master 456!",
            }
            patches = [
                patch.object(server, "PRODUCTION_MODE", True),
                patch.object(server, "RAILWAY_MODE", True),
                patch.object(server, "SESSION_SECRET_CONFIGURED", True),
                patch.object(server, "SESSION_SECRET", environment["SESSION_SECRET"]),
                patch.object(server, "STORAGE_ROOT", storage),
                patch.object(server, "DATA_DIR", data_dir),
                patch.object(server, "IMAGE_DIR", image_dir),
                patch.object(server, "PRODUCT_IMAGE_DIR", image_dir / "products"),
                patch.object(server, "HOMEPAGE_IMAGE_DIR", image_dir / "homepage"),
                patch.object(server, "SOURCE_IMAGE_DIR", source_images),
                patch.object(server, "SEED_DATA_DIR", seed_dir),
            ]
            with patch.dict("os.environ", environment, clear=True):
                for item in patches:
                    item.start()
                try:
                    server.initialize_storage()
                    self.assertEqual(server.read_json("products"), [{"id": 1, "name": "Seed Chair"}])
                    self.assertEqual(server.read_json("orders"), {"records": []})
                    saved_admin = server.admin_data()
                    self.assertTrue(server.verify_hash(environment["INITIAL_ADMIN_PASSWORD"], saved_admin["password_hash"]))
                    self.assertTrue(server.verify_hash(environment["INITIAL_MASTER_PASSWORD"], saved_admin["master_password_hash"]))

                    saved_product = {"id": 1, "name": "Owner Edited Chair"}
                    (data_dir / "products.json").write_text(json.dumps([saved_product]), encoding="utf-8")
                    target_image = image_dir / "products" / "oak-chair.jpg"
                    target_image.write_bytes(b"owner-managed-photo")
                    image_source.write_bytes(b"new-image-bundled-in-a-later-deploy")
                    os.environ["INITIAL_ADMIN_PASSWORD"] = "Replacement Admin 789!"
                    server.initialize_storage()

                    self.assertEqual(server.read_json("products"), [saved_product])
                    self.assertEqual(target_image.read_bytes(), b"owner-managed-photo")
                    self.assertTrue(server.verify_hash(environment["INITIAL_ADMIN_PASSWORD"], server.admin_data()["password_hash"]))
                    self.assertFalse(server.verify_hash(os.environ["INITIAL_ADMIN_PASSWORD"], server.admin_data()["password_hash"]))
                    self.assertTrue(server.valid_image_path("/images/products/oak-chair.jpg"))
                    served = server.static_file("images/products/oak-chair.jpg")
                    self.assertEqual(Path(served.path).resolve(), target_image.resolve())
                finally:
                    for item in reversed(patches):
                        item.stop()


if __name__ == "__main__":
    unittest.main()
