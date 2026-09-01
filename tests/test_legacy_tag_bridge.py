import hashlib
import hmac
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from backend.legacy_tag_bridge import JsonObjectStream, sign_payload, translate_frame  # noqa: E402


class LegacyTagBridgeTests(unittest.TestCase):
    def test_stream_decodes_fragmented_and_adjacent_objects(self):
        stream = JsonObjectStream()
        self.assertEqual(stream.feed(b'{"tag_id":"tag0","lin'), [])
        frames = stream.feed(
            b'ks":[{"A":"1782","R":"2.4"}]}\n'
            b'{"tag_id":"tag0","links":[]}'
        )
        self.assertEqual([frame["tag_id"] for frame in frames], ["tag0", "tag0"])
        self.assertEqual(frames[0]["links"][0], {"A": "1782", "R": "2.4"})

    def test_translate_frame_maps_legacy_links_and_tag_override(self):
        translated = translate_frame(
            {
                "tag_id": "tag0",
                "links": [
                    {"A": "1782", "R": "2.40"},
                    {"A": "1783", "R": 3.5},
                    {"A": "1782", "R": 9.9},
                    {"A": "bad", "R": "not-a-number"},
                ],
            },
            tag_id="TAG01",
        )
        self.assertIsNotNone(translated)
        assert translated is not None
        self.assertEqual(translated["tag_id"], "TAG01")
        self.assertEqual([item["anchor_id"] for item in translated["ranges"]], ["1782", "1783"])
        self.assertAlmostEqual(translated["ranges"][0]["distance_m"], 2.4)
        self.assertAlmostEqual(translated["ranges"][1]["distance_m"], 3.5)

    def test_translate_frame_rejects_missing_links_or_tag(self):
        self.assertIsNone(translate_frame({"tag_id": "tag0"}))
        self.assertIsNone(translate_frame({"links": []}))

    def test_signature_matches_backend_contract(self):
        secret = "a-long-test-secret-that-is-at-least-32-characters"
        body = b'{"message_id":"one"}'
        expected = hmac.new(
            secret.encode(),
            b"SUPALAI-TAG-GW-01.1700000000." + body,
            hashlib.sha256,
        ).hexdigest()
        self.assertEqual(
            sign_payload("SUPALAI-TAG-GW-01", "1700000000", body, secret),
            expected,
        )


if __name__ == "__main__":
    unittest.main()
