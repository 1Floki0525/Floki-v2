#!/usr/bin/env python3

import json
import os
import sys
import time
from pathlib import Path


def atomic_json(path, value):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(target.name + ".tmp-" + str(os.getpid()))
    with open(temp, "w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2)
        handle.write("\n")
    os.replace(temp, target)


def extract_json_object(text):
    decoder = json.JSONDecoder()
    for index, character in enumerate(text):
        if character != "{":
            continue
        try:
            value, _ = decoder.raw_decode(text[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    raise ValueError("Hugging Face REM output did not contain a JSON object")


def main():
    request_path = os.environ.get("FLOKI_REM_REQUEST_FILE")
    response_path = os.environ.get("FLOKI_REM_RESPONSE_FILE")
    if not request_path or not response_path:
        raise RuntimeError("FLOKI REM request/response paths are required")

    with open(request_path, "r", encoding="utf-8") as handle:
        request = json.load(handle)

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

    base_model_path = request["base_model_path"]
    adapter_path = request.get("adapter_path")
    compute_dtype = getattr(
        torch,
        request["compute_dtype"],
        None,
    )
    if compute_dtype is None:
        raise RuntimeError("unsupported configured compute dtype: " + str(request["compute_dtype"]))

    quantization = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type=request["quantization_type"],
        bnb_4bit_compute_dtype=compute_dtype,
        bnb_4bit_use_double_quant=bool(
            request["use_double_quant"]
        ),
    )

    tokenizer = AutoTokenizer.from_pretrained(
        base_model_path,
        use_fast=bool(request["tokenizer_use_fast"]),
    )
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    model = AutoModelForCausalLM.from_pretrained(
        base_model_path,
        quantization_config=quantization,
        device_map=request["device_map"],
        torch_dtype=compute_dtype,
    )

    if adapter_path:
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, adapter_path, is_trainable=False)

    messages = [
        {
            "role": "system",
            "content": request["system"],
        },
        {"role": "user", "content": request["prompt"]},
    ]

    try:
        rendered = tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
        )
    except (AttributeError, TypeError, ValueError):
        rendered = messages[0]["content"] + "\n\n" + messages[1]["content"]

    encoded = tokenizer(rendered, return_tensors="pt")
    model_device = next(model.parameters()).device
    encoded = {key: value.to(model_device) for key, value in encoded.items()}

    started = time.time()
    with torch.inference_mode():
        generated = model.generate(
            **encoded,
            max_new_tokens=int(request["max_new_tokens"]),
            temperature=float(request["temperature"]),
            top_p=float(request["top_p"]),
            do_sample=bool(request["do_sample"]),
            repetition_penalty=float(request["repetition_penalty"]),
            pad_token_id=tokenizer.pad_token_id,
            eos_token_id=tokenizer.eos_token_id,
        )

    prompt_tokens = encoded["input_ids"].shape[-1]
    output_tokens = generated[0][prompt_tokens:]
    raw_text = tokenizer.decode(output_tokens, skip_special_tokens=True).strip()
    response_json = extract_json_object(raw_text)

    atomic_json(
        response_path,
        {
            "marker": "FLOKI_V2_HF_REM_INFERENCE_PASS",
            "model": request["model_identity"],
            "response_json": response_json,
            "raw_stats": {
                "schema_constrained_json": True,
                "provider": request["provider"],
                "adapter_used": bool(adapter_path),
                "prompt_tokens": int(prompt_tokens),
                "generated_tokens": int(output_tokens.shape[-1]),
                "elapsed_seconds": time.time() - started,
            },
        },
    )
    print("FLOKI_V2_HF_REM_INFERENCE_PASS")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("FLOKI_V2_HF_REM_INFERENCE_FAIL " + str(error), file=sys.stderr)
        sys.exit(1)
