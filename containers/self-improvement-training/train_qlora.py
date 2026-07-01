#!/usr/bin/env python3

import json
import math
import os
import random
import sys
import time
from pathlib import Path

EXCLUSIVE_TRAINING_PREFLIGHT_VERSION = "FLOKI_EXCLUSIVE_TRAINING_PREFLIGHT_V2"


def load_config():
    config_path = os.environ.get("FLOKI_TRAINING_CONFIG_FILE")
    if not config_path:
        raise SystemExit("FLOKI_TRAINING_CONFIG_FILE is not set")
    with open(config_path, "r", encoding="utf-8") as handle:
        config = json.load(handle)
    if config.get("method") != "qlora":
        raise SystemExit("training config method must be 'qlora'")
    if config.get("full_finetune") is True:
        raise SystemExit("full-weight fine-tuning is not allowed")
    if not config.get("quantization", {}).get("load_in_4bit"):
        raise SystemExit("QLoRA requires 4-bit quantization (load_in_4bit)")
    return config


def read_dataset(path):
    records = []
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            text = record.get("text")
            if text:
                records.append({"text": text})
    if not records:
        raise SystemExit("dataset is empty: " + path)
    return records


def atomic_json(path, value):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(target.name + ".tmp-" + str(os.getpid()))
    with open(temp, "w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2)
        handle.write("\n")
    os.replace(temp, target)


def latest_checkpoint(output_dir, checkpoint_prefix, trainer_state_file_name):
    root = Path(output_dir)
    candidates = []
    if not root.exists():
        return None
    for entry in root.iterdir():
        if not entry.is_dir() or not entry.name.startswith(checkpoint_prefix):
            continue
        try:
            step = int(entry.name[len(checkpoint_prefix):])
        except (IndexError, ValueError):
            continue
        if (entry / trainer_state_file_name).is_file():
            candidates.append((step, entry))
    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0])
    return str(candidates[-1][1])


def write_metrics(adapter_dir, metrics, metrics_file_name):
    os.makedirs(adapter_dir, exist_ok=True)
    atomic_json(os.path.join(adapter_dir, metrics_file_name), metrics)



def emit_event(event_type, **detail):
    payload = {
        "type": event_type,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "detail": detail,
    }
    print(json.dumps(payload, sort_keys=True), flush=True)


def verify_gpu(config, torch):
    gpu = config.get("gpu") or {}
    if not torch.cuda.is_available():
        raise RuntimeError(
            "FLOKI_TRAINING_CUDA_UNAVAILABLE: CUDA-enabled PyTorch and an exposed NVIDIA GPU are required"
        )
    if not torch.version.cuda:
        raise RuntimeError("FLOKI_TRAINING_CPU_ONLY_TORCH: torch.version.cuda is empty")

    device_index = torch.cuda.current_device()
    actual_name = torch.cuda.get_device_name(device_index)
    actual_capability = tuple(torch.cuda.get_device_capability(device_index))
    expected_name = str(gpu.get("expected_name") or "").strip()
    expected_capability = tuple(int(value) for value in gpu.get("expected_compute_capability", []))

    if expected_name and actual_name != expected_name:
        raise RuntimeError(
            "FLOKI_TRAINING_GPU_NAME_MISMATCH: expected "
            + repr(expected_name)
            + " but found "
            + repr(actual_name)
        )
    if expected_capability and actual_capability != expected_capability:
        raise RuntimeError(
            "FLOKI_TRAINING_COMPUTE_CAPABILITY_MISMATCH: expected "
            + repr(expected_capability)
            + " but found "
            + repr(actual_capability)
        )

    bf16_supported = bool(torch.cuda.is_bf16_supported())
    if bool(gpu.get("require_bf16")) and not bf16_supported:
        raise RuntimeError(
            "FLOKI_TRAINING_BF16_UNAVAILABLE: configured GPU/PyTorch CUDA stack does not support BF16"
        )

    probe = torch.tensor([1.0, 2.0, 3.0], device="cuda", dtype=torch.float32)
    probe_total = float((probe * 2.0).sum().item())
    torch.cuda.synchronize()
    if probe_total != 12.0:
        raise RuntimeError("FLOKI_TRAINING_CUDA_PROBE_FAILED: unexpected tensor result")

    emit_event(
        "training_gpu_preflight_pass",
        marker="FLOKI_V2_RSI_GPU_PREFLIGHT_PASS",
        exclusive_training_preflight=EXCLUSIVE_TRAINING_PREFLIGHT_VERSION,
        torch_version=torch.__version__,
        torch_cuda_version=torch.version.cuda,
        cudnn_version=torch.backends.cudnn.version(),
        gpu_name=actual_name,
        compute_capability=list(actual_capability),
        bf16_supported=bf16_supported,
    )


def optimizer_step_budget(dataset_size, training):
    batch_size = max(1, int(training["per_device_train_batch_size"]))
    accumulation = max(1, int(training["gradient_accumulation_steps"]))
    max_steps = int(training["max_steps"])
    if max_steps > 0:
        return max_steps
    updates_per_epoch = max(1, math.ceil(dataset_size / (batch_size * accumulation)))
    return max(1, math.ceil(updates_per_epoch * float(training["num_train_epochs"])))

def main():
    config = load_config()

    import numpy as np
    import torch
    from datasets import Dataset
    from transformers import (
        AutoModelForCausalLM,
        AutoTokenizer,
        BitsAndBytesConfig,
        TrainerCallback,
    )
    from transformers.trainer import TRAINING_ARGS_NAME
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
    from trl import SFTConfig, SFTTrainer
    verify_gpu(config, torch)

    quant = config["quantization"]
    compute_dtype = getattr(
        torch,
        quant["bnb_4bit_compute_dtype"],
        None,
    )

    if compute_dtype is None:
        raise RuntimeError("unsupported configured compute dtype: " + str(quant["bnb_4bit_compute_dtype"]))

    bnb_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type=quant["bnb_4bit_quant_type"],
        bnb_4bit_compute_dtype=compute_dtype,
        bnb_4bit_use_double_quant=bool(
            quant["bnb_4bit_use_double_quant"]
        ),
    )

    base_path = config["base_model_path"]
    tokenizer = AutoTokenizer.from_pretrained(
        base_path,
        use_fast=bool(config["tokenizer_use_fast"]),
    )
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    model = AutoModelForCausalLM.from_pretrained(
        base_path,
        quantization_config=bnb_config,
        device_map=config["device_map"],
        dtype=compute_dtype,
    )
    model = prepare_model_for_kbit_training(model)

    lora = config["lora"]
    peft_config = LoraConfig(
        r=int(lora["r"]),
        lora_alpha=int(lora["alpha"]),
        lora_dropout=float(lora["dropout"]),
        target_modules=list(lora["target_modules"]),
        bias=config["lora"]["bias"],
        task_type=config["lora"]["task_type"],
    )
    model = get_peft_model(model, peft_config)

    records = read_dataset(config["dataset_path"])
    dataset = Dataset.from_list(records)

    tparams = config["training"]
    adapter_dir = config["adapter_output_path"]
    scheduler = config["scheduler"]
    os.makedirs(adapter_dir, exist_ok=True)

    control_file = scheduler["control_file"]
    response_file = scheduler["control_response_file"]
    segment_number = int(scheduler["segment_number"])

    class CheckpointControlCallback(TrainerCallback):
        def __init__(self):
            self.handled_request_id = None
            self.pending_request_id = None
            self.acknowledged = False

        def _save_checkpoint(self, args, state, kwargs, request_id):
            step = int(getattr(state, "global_step", 0) or 0)
            checkpoint_dir = os.path.join(
                adapter_dir,
                config["checkpoint_dir_prefix"] + str(step),
            )
            os.makedirs(checkpoint_dir, exist_ok=True)

            callback_model = kwargs.get("model")
            callback_tokenizer = (
                kwargs.get("processing_class")
                or kwargs.get("tokenizer")
                or tokenizer
            )
            optimizer = kwargs.get("optimizer")
            lr_scheduler = kwargs.get("lr_scheduler")

            callback_model.save_pretrained(checkpoint_dir)
            callback_tokenizer.save_pretrained(checkpoint_dir)
            state.save_to_json(
                os.path.join(checkpoint_dir, config["trainer_state_file_name"])
            )
            torch.save(args, os.path.join(checkpoint_dir, TRAINING_ARGS_NAME))
            if optimizer is not None:
                torch.save(
                    optimizer.state_dict(),
                    os.path.join(checkpoint_dir, config["optimizer_state_file_name"]),
                )
            if lr_scheduler is not None:
                torch.save(
                    lr_scheduler.state_dict(),
                    os.path.join(checkpoint_dir, config["lr_scheduler_state_file_name"]),
                )

            rng_state = {
                "python": random.getstate(),
                "numpy": np.random.get_state(),
                "cpu": torch.get_rng_state(),
            }
            if torch.cuda.is_available():
                rng_state["cuda"] = torch.cuda.get_rng_state_all()
            torch.save(rng_state, os.path.join(checkpoint_dir, config["rng_state_file_name"]))

            atomic_json(
                response_file,
                {
                    "marker": "FLOKI_V2_RSI_TRAINING_CHECKPOINT_ACK",
                    "request_id": request_id,
                    "checkpoint_dir": checkpoint_dir,
                    "global_step": step,
                    "segment_number": segment_number,
                    "acknowledged_at": time.strftime(
                        "%Y-%m-%dT%H:%M:%SZ", time.gmtime()
                    ),
                },
            )
            self.handled_request_id = request_id
            self.acknowledged = True

        def _read_checkpoint_request(self):
            if not control_file or not response_file:
                return None
            try:
                with open(control_file, "r", encoding="utf-8") as handle:
                    request = json.load(handle)
            except (FileNotFoundError, json.JSONDecodeError, OSError):
                return None

            request_id = str(request.get("request_id") or "").strip()
            action = str(request.get("action") or "").strip()
            if (
                action != "checkpoint_and_stop"
                or not request_id
                or request_id == self.handled_request_id
            ):
                return None
            return request_id

        def on_step_end(self, args, state, control, **kwargs):
            request_id = self._read_checkpoint_request()
            if request_id:
                self.pending_request_id = request_id
            return control

        def on_epoch_end(self, args, state, control, **kwargs):
            request_id = (
                self.pending_request_id
                or self._read_checkpoint_request()
            )
            if not request_id or request_id == self.handled_request_id:
                return control

            self._save_checkpoint(args, state, kwargs, request_id)
            try:
                os.unlink(control_file)
            except FileNotFoundError:
                pass
            self.pending_request_id = None
            control.should_training_stop = True
            control.should_save = False
            return control

    max_steps = int(tparams["max_steps"])
    total_optimizer_steps = optimizer_step_budget(len(dataset), tparams)
    warmup_steps = int(math.ceil(total_optimizer_steps * float(tparams["warmup_ratio"])))

    training_args = SFTConfig(
        output_dir=adapter_dir,
        per_device_train_batch_size=int(tparams["per_device_train_batch_size"]),
        gradient_accumulation_steps=int(tparams["gradient_accumulation_steps"]),
        learning_rate=float(tparams["learning_rate"]),
        num_train_epochs=float(tparams["num_train_epochs"]),
        max_steps=max_steps,
        warmup_steps=warmup_steps,
        weight_decay=float(tparams["weight_decay"]),
        lr_scheduler_type=tparams["lr_scheduler_type"],
        optim=tparams["optim"],
        seed=int(tparams["seed"]),
        logging_steps=int(tparams["logging_steps"]),
        save_steps=int(tparams["save_steps"]),
        save_strategy=tparams["save_strategy"],
        save_total_limit=int(tparams["save_total_limit"]),
        bf16=compute_dtype == torch.bfloat16,
        report_to=list(tparams["report_to"]),
        disable_tqdm=bool(tparams["disable_tqdm"]),
        dataset_text_field=config["dataset_text_field"],
        max_length=int(tparams["max_seq_length"]),
    )

    control_callback = CheckpointControlCallback()
    trainer = SFTTrainer(
        model=model,
        args=training_args,
        train_dataset=dataset,
        processing_class=tokenizer,
        callbacks=[control_callback],
    )

    resume_value = scheduler["resume_from_checkpoint"]
    if resume_value == "latest":
        resume_value = latest_checkpoint(
            adapter_dir,
            config["checkpoint_dir_prefix"],
            config["trainer_state_file_name"],
        )
    elif resume_value == "none":
        resume_value = None
    elif not resume_value:
        raise RuntimeError("configured resume policy is empty")

    started = time.time()
    train_result = trainer.train(resume_from_checkpoint=resume_value)
    elapsed = time.time() - started

    trainer.model.save_pretrained(adapter_dir)
    tokenizer.save_pretrained(adapter_dir)
    trainer.state.save_to_json(
        os.path.join(adapter_dir, config["trainer_state_file_name"])
    )

    metrics = dict(getattr(train_result, "metrics", {}) or {})
    metrics.update(
        {
            "elapsed_seconds": elapsed,
            "record_count": len(records),
            "seed": int(tparams["seed"]),
            "method": "qlora",
            "global_step": int(getattr(trainer.state, "global_step", 0) or 0),
            "segment_number": segment_number,
            "resume_from_checkpoint": resume_value,
            "checkpoint_request_acknowledged": control_callback.acknowledged,
            "completed_epochs": int(float(
                metrics.get("epoch", 0) or 0
            )),
        }
    )
    write_metrics(adapter_dir, metrics, config["metrics_file_name"])
    print("FLOKI_V2_RSI_TRAINING_COMPLETE " + json.dumps(metrics))


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as error:
        print("FLOKI_V2_RSI_TRAINING_FAILED " + str(error), file=sys.stderr)
        sys.exit(1)
