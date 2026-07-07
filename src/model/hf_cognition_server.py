#!/usr/bin/env python3
from __future__ import annotations

import base64
import datetime as _dt
import io
import json
import os
import re
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

SERVER_STARTED_AT = time.time()


def first_env(*names: str, default: str = "") -> str:
    for name in names:
        value = os.environ.get(name)
        if value is not None and str(value).strip() != "":
            return str(value).strip()
    return default


def env_bool(*names: str, default: bool = False) -> bool:
    raw = first_env(*names, default="1" if default else "0").strip().lower()
    return raw in ("1", "true", "yes", "on", "enabled")


def positive_int_env(name: str, fallback: int) -> int:
    try:
        value = int(str(os.environ.get(name, "")).strip())
        if value > 0:
            return value
    except Exception:
        pass
    return fallback


MODEL_ID = first_env("FLOKI_HF_COGNITION_MODEL", "FLOKI_COGNITION_MODEL", "FLOKI_HF_MODEL")
HOST = first_env("FLOKI_HF_COGNITION_HOST", "FLOKI_HF_HOST")
PORT_RAW = first_env("FLOKI_HF_COGNITION_PORT", "FLOKI_HF_PORT")
DEVICE_PREF = first_env("FLOKI_HF_COGNITION_DEVICE", "FLOKI_HF_DEVICE", default="auto").lower()
USE_4BIT = env_bool("FLOKI_HF_COGNITION_4BIT", "FLOKI_HF_LOAD_IN_4BIT", "FLOKI_HF_4BIT", default=False)
DTYPE_PREF = first_env("FLOKI_HF_COGNITION_DTYPE", "FLOKI_HF_DTYPE", default="auto").lower()
GPU_INDEX = first_env("FLOKI_HF_COGNITION_GPU_INDEX", "FLOKI_HF_GPU_INDEX", "GPU_INDEX")
GPU_MAX_MEMORY = first_env("FLOKI_HF_COGNITION_GPU_MAX_MEMORY", "FLOKI_HF_GPU_MAX_MEMORY", "GPU_MAX_MEMORY")
CPU_MAX_MEMORY = first_env("FLOKI_HF_COGNITION_CPU_MAX_MEMORY", "FLOKI_HF_CPU_MAX_MEMORY", "CPU_MAX_MEMORY")
DEFAULT_MAX_NEW_TOKENS = positive_int_env("FLOKI_HF_COGNITION_MAX_NEW_TOKENS", 256)
DEFAULT_REPETITION_PENALTY = float(first_env("FLOKI_HF_COGNITION_REPETITION_PENALTY", "FLOKI_HF_REPETITION_PENALTY", default="1.05"))
MULTIMODAL_ENABLED = env_bool(
    "FLOKI_HF_COGNITION_MULTIMODAL_ENABLED",
    "FLOKI_HF_MULTIMODAL_ENABLED",
    "FLOKI_MULTIMODAL_ENABLED",
    default=True,
)

processor = None
tokenizer = None
model = None
torch = None
TextIteratorStreamer = None

MODEL_LOAD_ERROR = None
MODEL_DEVICE = "unknown"
MODEL_DTYPE = "unknown"
MODEL_LOAD_SECONDS = None
MODEL_WARMED = False
MODEL_LOCK = threading.Lock()
MODEL_LOAD_KIND = "unloaded"
MODEL_CLASS_NAME = None
PROCESSOR_CLASS_NAME = None
MULTIMODAL_LOADED = False
FALLBACK_REASON = None


def iso_now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat().replace("+00:00", "Z")


def decode_data_url_image(value: str):
    match = re.match(r"^data:image/[^;,]+;base64,(.+)$", value.strip(), flags=re.I | re.S)
    if not match:
        return None
    try:
        from PIL import Image
    except Exception as exc:
        raise RuntimeError("PIL is required to decode data-url images for multimodal input") from exc
    raw = base64.b64decode(match.group(1), validate=False)
    return Image.open(io.BytesIO(raw)).convert("RGB")


def load_local_image(value: str):
    candidate = value[7:] if value.startswith("file://") else value
    try:
        path = Path(candidate).expanduser()
    except Exception:
        return None
    if not path.exists() or not path.is_file():
        return None
    try:
        from PIL import Image
    except Exception as exc:
        raise RuntimeError("PIL is required to decode local image inputs") from exc
    return Image.open(path).convert("RGB")


def image_part_from_string(value: str) -> dict:
    decoded = decode_data_url_image(value)
    if decoded is not None:
        return {"type": "image", "image": decoded}
    loaded = load_local_image(value)
    if loaded is not None:
        return {"type": "image", "image": loaded}
    if value.startswith(("http://", "https://")):
        return {"type": "image", "url": value}
    if re.fullmatch(r"[A-Za-z0-9+/=\s]+", value.strip()) and len(value.strip()) > 64:
        decoded = decode_data_url_image("data:image/jpeg;base64," + value.strip())
        if decoded is not None:
            return {"type": "image", "image": decoded}
    return {"type": "image", "url": value}


def normalize_content_part(part):
    if not isinstance(part, dict):
        return {"type": "text", "text": str(part)}

    part_type = str(part.get("type") or "").strip().lower()
    if part_type in ("text", "input_text"):
        return {"type": "text", "text": str(part.get("text") or part.get("content") or "")}

    if part_type in ("image", "input_image"):
        image_value = part.get("image") or part.get("url") or part.get("path")
        if isinstance(image_value, str):
            return image_part_from_string(image_value)
        if image_value is not None:
            return {"type": "image", "image": image_value}

    if part_type == "image_url":
        image_url = part.get("image_url")
        if isinstance(image_url, dict):
            image_url = image_url.get("url") or image_url.get("image")
        if isinstance(image_url, str):
            return image_part_from_string(image_url)

    if part_type in ("video", "input_video"):
        video_value = part.get("video") or part.get("url") or part.get("path")
        if isinstance(video_value, str):
            loaded = load_local_image(video_value)
            if loaded is not None:
                return {"type": "image", "image": loaded}
            return {"type": "video", "url": video_value}
        if video_value is not None:
            return {"type": "video", "video": video_value}

    return {"type": "text", "text": str(part.get("text") or part.get("content") or part)}


def normalize_messages(payload: dict) -> list[dict]:
    source_messages = payload.get("messages")
    messages: list[dict] = []

    if isinstance(source_messages, list):
        for raw in source_messages:
            if not isinstance(raw, dict):
                continue
            role = str(raw.get("role") or "user")
            content = raw.get("content")
            if isinstance(content, list):
                content = [normalize_content_part(part) for part in content]
            else:
                content = str(content or "")
            messages.append({"role": role, "content": content})

    if not messages:
        content = []
        images = payload.get("images")
        if isinstance(images, list):
            for image in images:
                if isinstance(image, str) and image.strip():
                    content.append(image_part_from_string(image.strip()))
        prompt = str(payload.get("prompt") or payload.get("content") or "")
        content.append({"type": "text", "text": prompt})
        system = str(payload.get("system") or "").strip()
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": content if images else prompt})

    return messages


def flatten_messages_for_text(messages: list[dict]) -> list[dict]:
    flattened = []
    for message in messages:
        role = str(message.get("role") or "user")
        content = message.get("content")
        if isinstance(content, list):
            parts = []
            for part in content:
                if isinstance(part, dict) and str(part.get("type") or "").lower() == "text":
                    text = str(part.get("text") or "").strip()
                    if text:
                        parts.append(text)
            content_text = "\n".join(parts)
        else:
            content_text = str(content or "")
        flattened.append({"role": role, "content": content_text})
    return flattened


def select_dtype(_torch, use_cuda: bool):
    if use_cuda:
        if DTYPE_PREF == "bfloat16":
            return _torch.bfloat16
        if DTYPE_PREF == "float32":
            return _torch.float32
        return _torch.float16
    return _torch.float32


def model_primary_device():
    if model is None:
        return "cpu"
    dev = getattr(model, "device", None)
    if dev is not None:
        return dev
    try:
        return next(model.parameters()).device
    except Exception:
        return "cpu"


def move_inputs(inputs):
    target = model_primary_device()
    if hasattr(inputs, "to"):
        return inputs.to(target)
    moved = {}
    for key, value in dict(inputs).items():
        moved[key] = value.to(target) if hasattr(value, "to") else value
    return moved



def env_flag(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return str(raw).strip().lower() in ("1", "true", "yes", "on", "enabled")


def chat_template_kwargs(payload: dict) -> dict:
    # Qwen3.5 current serving guidance uses chat_template_kwargs.enable_thinking.
    # Default to thinking-enabled mode for cognition for this local runtime so live chat and webcam
    # observations do not store visible scratchpad text.
    supplied = payload.get("chat_template_kwargs")
    kwargs = dict(supplied) if isinstance(supplied, dict) else {}

    if "enable_thinking" not in kwargs:
        if "enable_thinking" in payload:
            kwargs["enable_thinking"] = bool(payload.get("enable_thinking"))
        else:
            kwargs["enable_thinking"] = env_flag("FLOKI_HF_ENABLE_THINKING", True)

    return kwargs


def apply_processor_chat_template(active_processor, messages: list[dict], payload: dict):
    base_kwargs = {
        "add_generation_prompt": True,
        "tokenize": True,
        "return_dict": True,
        "return_tensors": "pt",
    }
    thinking_kwargs = chat_template_kwargs(payload)
    try:
        return active_processor.apply_chat_template(messages, **base_kwargs, **thinking_kwargs)
    except TypeError:
        return active_processor.apply_chat_template(messages, **base_kwargs)


def apply_tokenizer_chat_template(active_tokenizer, messages: list[dict], payload: dict) -> str:
    base_kwargs = {
        "tokenize": False,
        "add_generation_prompt": True,
    }
    thinking_kwargs = chat_template_kwargs(payload)
    try:
        return active_tokenizer.apply_chat_template(messages, **base_kwargs, **thinking_kwargs)
    except TypeError:
        return active_tokenizer.apply_chat_template(messages, **base_kwargs)


def strip_visible_thinking(text: str) -> str:
    cleaned = str(text or "")
    cleaned = re.sub(r"(?is)<think>.*?</think>\s*", "", cleaned).strip()

    if re.match(r"(?is)^\s*Thinking Process\s*:", cleaned):
        marker_patterns = [
            r"(?is)\bFinal answer\s*:\s*",
            r"(?is)\bFinal response\s*:\s*",
            r"(?is)\bAnswer\s*:\s*",
            r"(?is)\bObservation\s*:\s*",
        ]
        for pattern in marker_patterns:
            matches = list(re.finditer(pattern, cleaned))
            if matches:
                cleaned = cleaned[matches[-1].end():].strip()
                break
        else:
            return ""

    cleaned = re.sub(r"(?is)^\s*(Final answer|Final response|Answer|Observation)\s*:\s*", "", cleaned).strip()
    return cleaned


def encode_prompt(payload: dict):
    messages = normalize_messages(payload)

    if MULTIMODAL_LOADED:
        inputs = apply_processor_chat_template(processor, messages, payload)
        return messages, move_inputs(inputs)

    text_messages = flatten_messages_for_text(messages)
    try:
        prompt_text = apply_tokenizer_chat_template(tokenizer, text_messages, payload)
    except Exception:
        prompt_text = "\n\n".join(
            str(item.get("role") or "user").capitalize() + ":\n" + str(item.get("content") or "")
            for item in text_messages
        ) + "\n\nAssistant:\n"
    inputs = tokenizer(prompt_text, return_tensors="pt")
    if MODEL_DEVICE == "cuda":
        inputs = {key: value.to(model_primary_device()) for key, value in inputs.items()}
    return prompt_text, inputs


def parse_generation_options(payload: dict, chat: bool = False) -> dict:
    options = payload.get("options") if isinstance(payload.get("options"), dict) else {}
    max_cap = DEFAULT_MAX_NEW_TOKENS
    requested = payload.get("num_predict", options.get("num_predict", options.get("max_new_tokens", max_cap)))
    try:
        max_new_tokens = max(1, min(int(requested), max_cap))
    except Exception:
        max_new_tokens = max_cap

    if not chat:
        images = payload.get("images")
        if isinstance(images, list) and images:
            startup_cap = positive_int_env("FLOKI_HF_VISION_STARTUP_PROBE_MAX_NEW_TOKENS", 32)
            max_new_tokens = max(1, min(max_new_tokens, startup_cap))
        else:
            legacy_cap = positive_int_env("FLOKI_HF_VISION_GENERATE_MAX_NEW_TOKENS", max_new_tokens)
            max_new_tokens = max(1, min(max_new_tokens, legacy_cap))

    temperature = float(options.get("temperature", payload.get("temperature", 0.55)) or 0.55)
    top_p = float(options.get("top_p", payload.get("top_p", 0.9)) or 0.9)
    out = {
        "max_new_tokens": max_new_tokens,
        "temperature": max(0.0, temperature),
        "top_p": max(0.01, min(top_p, 1.0)),
        "do_sample": temperature > 0,
        "repetition_penalty": float(options.get("repetition_penalty", DEFAULT_REPETITION_PENALTY) or DEFAULT_REPETITION_PENALTY),
    }
    active_tokenizer = tokenizer or getattr(processor, "tokenizer", None)
    if active_tokenizer is not None:
        eos_id = getattr(active_tokenizer, "eos_token_id", None)
        pad_id = getattr(active_tokenizer, "pad_token_id", None) or eos_id
        if pad_id is not None:
            out["pad_token_id"] = pad_id
    return out


def envelope(response: str, done: bool, extra: dict | None = None, chat: bool = False) -> bytes:
    body = {"model": MODEL_ID, "created_at": iso_now(), "done": done}
    if chat:
        body["message"] = {"role": "assistant", "content": response}
    else:
        body["response"] = response
    if extra:
        body.update(extra)
    return (json.dumps(body, ensure_ascii=False) + "\n").encode("utf-8")


def load_model() -> None:
    global processor, tokenizer, model, torch, TextIteratorStreamer
    global MODEL_LOAD_ERROR, MODEL_DEVICE, MODEL_DTYPE, MODEL_LOAD_SECONDS, MODEL_WARMED
    global MODEL_LOAD_KIND, MODEL_CLASS_NAME, PROCESSOR_CLASS_NAME, MULTIMODAL_LOADED, FALLBACK_REASON

    if not MODEL_ID:
        raise RuntimeError("FLOKI_HF_COGNITION_MODEL is required from YAML-derived service environment")
    if not HOST:
        raise RuntimeError("FLOKI_HF_COGNITION_HOST is required from YAML-derived service environment")
    if not PORT_RAW:
        raise RuntimeError("FLOKI_HF_COGNITION_PORT is required from YAML-derived service environment")

    started = time.time()
    try:
        import torch as _torch
        from transformers import AutoModelForCausalLM, AutoTokenizer, TextIteratorStreamer as _TextIteratorStreamer

        torch = _torch
        TextIteratorStreamer = _TextIteratorStreamer

        use_cuda = torch.cuda.is_available() and DEVICE_PREF not in ("cpu", "none", "off")
        dtype = select_dtype(torch, use_cuda)
        MODEL_DEVICE = "cuda" if use_cuda else "cpu"
        MODEL_DTYPE = str(dtype).replace("torch.", "")

        kwargs = {"trust_remote_code": True, "low_cpu_mem_usage": True}
        if use_cuda:
            kwargs["torch_dtype"] = dtype
            kwargs["device_map"] = "auto"
            if GPU_MAX_MEMORY and GPU_INDEX != "":
                max_memory = {int(GPU_INDEX): GPU_MAX_MEMORY}
                if CPU_MAX_MEMORY:
                    max_memory["cpu"] = CPU_MAX_MEMORY
                kwargs["max_memory"] = max_memory
            if USE_4BIT:
                from transformers import BitsAndBytesConfig
                kwargs["quantization_config"] = BitsAndBytesConfig(
                    load_in_4bit=True,
                    bnb_4bit_quant_type="nf4",
                    bnb_4bit_compute_dtype=dtype,
                    bnb_4bit_use_double_quant=True,
                )
        else:
            kwargs["torch_dtype"] = torch.float32

        if MULTIMODAL_ENABLED:
            try:
                from transformers import AutoModelForMultimodalLM, AutoProcessor
                processor = AutoProcessor.from_pretrained(MODEL_ID, trust_remote_code=True)
                model = AutoModelForMultimodalLM.from_pretrained(MODEL_ID, **kwargs)
                tokenizer = getattr(processor, "tokenizer", None) or AutoTokenizer.from_pretrained(MODEL_ID, trust_remote_code=True)
                MULTIMODAL_LOADED = True
                MODEL_LOAD_KIND = "multimodal"
                PROCESSOR_CLASS_NAME = processor.__class__.__name__
                MODEL_CLASS_NAME = model.__class__.__name__
            except Exception as exc:
                FALLBACK_REASON = "multimodal load unavailable: " + str(exc)
                MULTIMODAL_LOADED = False
                processor = None

        if model is None:
            tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, trust_remote_code=True)
            model = AutoModelForCausalLM.from_pretrained(MODEL_ID, **kwargs)
            MODEL_LOAD_KIND = "causal_lm_fallback"
            MODEL_CLASS_NAME = model.__class__.__name__
            PROCESSOR_CLASS_NAME = None
            if FALLBACK_REASON is None:
                FALLBACK_REASON = "multimodal loading disabled"

        model.eval()
        if not use_cuda:
            model.to("cpu")

        warm_payload = {
            "messages": [{"role": "user", "content": "Reply with the single word: ready"}],
            "options": {"temperature": 0, "top_p": 1, "max_new_tokens": 1},
        }
        _, inputs = encode_prompt(warm_payload)
        warm_opts = parse_generation_options(warm_payload, chat=True)
        warm_opts["max_new_tokens"] = 1
        warm_opts["do_sample"] = False
        with torch.inference_mode():
            _ = model.generate(**inputs, **warm_opts)
        if use_cuda:
            torch.cuda.synchronize()

        MODEL_WARMED = True
        MODEL_LOAD_SECONDS = round(time.time() - started, 3)
        print(json.dumps({
            "ok": True,
            "marker": "FLOKI_HF_COGNITION_MODEL_WARMED",
            "model": MODEL_ID,
            "device": MODEL_DEVICE,
            "dtype": MODEL_DTYPE,
            "use_4bit": USE_4BIT,
            "load_seconds": MODEL_LOAD_SECONDS,
            "multimodal_enabled": MULTIMODAL_ENABLED,
            "multimodal_loaded": MULTIMODAL_LOADED,
            "load_kind": MODEL_LOAD_KIND,
            "model_class": MODEL_CLASS_NAME,
            "processor_class": PROCESSOR_CLASS_NAME,
            "fallback_reason": FALLBACK_REASON,
        }), flush=True)
    except Exception as error:
        MODEL_LOAD_ERROR = traceback.format_exc()
        print(json.dumps({
            "ok": False,
            "marker": "FLOKI_HF_COGNITION_MODEL_LOAD_FAILED",
            "model": MODEL_ID,
            "error": str(error),
        }), flush=True)
        raise


class Handler(BaseHTTPRequestHandler):
    server_version = "FlokiHFCognition/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (iso_now(), fmt % args))

    def send_json(self, code: int, body: dict):
        raw = json.dumps(body, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/health", "/ready"):
            ok = model is not None and MODEL_WARMED is True and MODEL_LOAD_ERROR is None
            self.send_json(200 if ok else 503, {
                "ok": ok,
                "marker": "FLOKI_HF_COGNITION_HEALTH",
                "model": MODEL_ID,
                "loaded": model is not None,
                "warmed": MODEL_WARMED,
                "device": MODEL_DEVICE,
                "dtype": MODEL_DTYPE,
                "use_4bit": USE_4BIT,
                "load_seconds": MODEL_LOAD_SECONDS,
                "uptime_seconds": round(time.time() - SERVER_STARTED_AT, 3),
                "error": MODEL_LOAD_ERROR,
                "multimodal_enabled": MULTIMODAL_ENABLED,
                "multimodal_loaded": MULTIMODAL_LOADED,
                "load_kind": MODEL_LOAD_KIND,
                "model_class": MODEL_CLASS_NAME,
                "processor_class": PROCESSOR_CLASS_NAME,
                "fallback_reason": FALLBACK_REASON,
            })
            return
        if path == "/api/tags":
            warmed = model is not None and MODEL_WARMED is True and MODEL_LOAD_ERROR is None
            self.send_json(200 if warmed else 503, {
                "models": [{
                    "name": MODEL_ID,
                    "model": MODEL_ID,
                    "details": {
                        "family": os.environ.get("MODEL_FAMILY", MODEL_ID.rsplit("/", 1)[-1] if MODEL_ID else "configured"),
                        "parameter_size": os.environ.get("MODEL_PARAMETER_SIZE", ""),
                        "quantization_level": os.environ.get("MODEL_QUANTIZATION_LEVEL", "configured_4bit" if USE_4BIT else MODEL_DTYPE),
                    },
                }] if warmed else [],
            })
            return
        self.send_json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        is_chat = path in ("/api/chat", "/chat", "/v1/chat/completions")
        if not is_chat and path not in ("/api/generate", "/generate"):
            self.send_json(404, {"ok": False, "error": "not found"})
            return
        try:
            length = int(self.headers.get("content-length") or "0")
            payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        except Exception as error:
            self.send_json(400, {"ok": False, "error": "invalid JSON: " + str(error)})
            return
        if model is None or not MODEL_WARMED:
            self.send_json(503, {"ok": False, "error": "HF cognition model is not warmed", "model": MODEL_ID})
            return
        try:
            if payload.get("stream") is True:
                self.handle_stream(payload, chat=is_chat)
            else:
                self.handle_non_stream(payload, chat=is_chat)
        except Exception as error:
            self.send_json(500, {"ok": False, "error": str(error), "trace": traceback.format_exc()[-4000:]})

    def handle_non_stream(self, payload: dict, chat: bool = False):
        started = time.time()
        with MODEL_LOCK:
            _, inputs = encode_prompt(payload)
            gen_opts = parse_generation_options(payload, chat=chat)
            input_len = int(inputs["input_ids"].shape[-1])
            with torch.inference_mode():
                output = model.generate(**inputs, **gen_opts)
            generated = output[0][input_len:]
            if MULTIMODAL_LOADED and processor is not None and hasattr(processor, "decode"):
                text = processor.decode(generated, skip_special_tokens=True)
            else:
                text = tokenizer.decode(generated, skip_special_tokens=True)
            if payload.get("strip_thinking", True) is not False:
                text = strip_visible_thinking(text)
            if MODEL_DEVICE == "cuda":
                torch.cuda.synchronize()
        raw = envelope(text, True, {
            "done_reason": "stop",
            "total_duration": int((time.time() - started) * 1_000_000_000),
            "eval_count": int(len(generated)),
            "streaming": False,
            "multimodal_loaded": MULTIMODAL_LOADED,
            "load_kind": MODEL_LOAD_KIND,
        }, chat=chat).rstrip(b"\n")
        self.send_response(200)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def handle_stream(self, payload: dict, chat: bool = False):
        started = time.time()
        _, inputs = encode_prompt(payload)
        gen_opts = parse_generation_options(payload, chat=chat)
        stream_tokenizer = tokenizer or getattr(processor, "tokenizer", None)
        streamer = TextIteratorStreamer(stream_tokenizer, skip_prompt=True, skip_special_tokens=True)
        kwargs = dict(inputs)
        kwargs.update(gen_opts)
        kwargs["streamer"] = streamer

        self.send_response(200)
        self.send_header("content-type", "application/x-ndjson; charset=utf-8")
        self.send_header("cache-control", "no-cache")
        self.end_headers()

        generated_chars = 0
        generated_chunks = 0

        def run_generate():
            with MODEL_LOCK:
                with torch.inference_mode():
                    model.generate(**kwargs)
                if MODEL_DEVICE == "cuda":
                    torch.cuda.synchronize()

        worker = threading.Thread(target=run_generate, daemon=True)
        worker.start()
        for chunk in streamer:
            if not chunk:
                continue
            generated_chunks += 1
            generated_chars += len(chunk)
            self.wfile.write(envelope(chunk, False, chat=chat))
            self.wfile.flush()
        worker.join()
        self.wfile.write(envelope("", True, {
            "done_reason": "stop",
            "total_duration": int((time.time() - started) * 1_000_000_000),
            "eval_count": generated_chars,
            "streaming": True,
            "ndjson_envelope_count": generated_chunks + 1,
            "multimodal_loaded": MULTIMODAL_LOADED,
            "load_kind": MODEL_LOAD_KIND,
        }, chat=chat))
        self.wfile.flush()


def main():
    load_model()
    httpd = ThreadingHTTPServer((HOST, int(PORT_RAW)), Handler)
    print(json.dumps({
        "ok": True,
        "marker": "FLOKI_HF_COGNITION_SERVER_LISTENING",
        "host": HOST,
        "port": int(PORT_RAW),
        "model": MODEL_ID,
        "multimodal_enabled": MULTIMODAL_ENABLED,
        "multimodal_loaded": MULTIMODAL_LOADED,
    }), flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
