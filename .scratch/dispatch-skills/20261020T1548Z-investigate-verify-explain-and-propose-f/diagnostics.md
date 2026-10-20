# Dispatch diagnostics

Review before sharing. This report holds dispatch-owned data only: no user source, objective, repository paths, or identities. Proposed fixes are unverified.

`—` marks an unavailable value; `~` marks an estimate excluded from measured totals.

## Summary

- Build: dispatch 0.7.2 · build 061946b6d5f3
- Host: codex · OS: win32
- Runs: 1 · wall time: 1m 59s
- Provider CLI measured tokens: — · launch coverage —
- Estimated, excluded from measured totals: native and write — · orchestrator frame exposure ~593
- Full conversation totals are unavailable: provider measurements cover reported launches only; frame exposure is not full orchestrator usage.
- Host retro: 0 accepted · 0 rejected

Top findings:

- none

## Overview

| Run | Phase | Outcome | Wall | Driver | Host | User wait | Invocations | Input | Cache read | Cache write | Output | Coverage |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 · plan · low | plan | complete | 1m 52s | <1s | 1m 52s | <1s | 0 | — | — | — | — | — |
| 1 · plan · low | plan review | skipped | 6s | <1s | 6s | <1s | 0 | — | — | — | — | — |
| 1 · plan · low | all phases | complete | 1m 59s | <1s | 1m 59s | <1s | 0 | — | — | — | — | — |

### Tokens by provider and model

| Provider | Model | Input | Cache read | Cache write | Output | Coverage |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| — | — | — | — | — | — | — |

## Findings

No findings.

## Appendix

<details>
<summary>Invocations and configuration</summary>

| Run | Phase | Provider | Model | Effort | Duration | Input | Cache read | Cache write | Output | Total | Outcome |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |

Run 1: verb plan, level low, pins —, outcome complete.

```json
{
  "diagnostics": true,
  "write-concurrency": 3,
  "read-delegates": {
    "claude": {
      "sandbox": false,
      "targets": [
        {
          "low": {
            "model": "claude-opus-5-5",
            "effort": "low"
          },
          "max": {
            "model": "claude-opus-5-5",
            "effort": "medium"
          }
        }
      ]
    },
    "codex": {
      "sandbox": false,
      "targets": [
        {
          "low": {
            "model": "gpt-6.1-sol",
            "effort": "low"
          },
          "max": {
            "model": "gpt-6.1-sol",
            "effort": "medium"
          }
        }
      ]
    },
    "agy": {
      "targets": [
        {
          "low": {
            "model": "gemini-3.8-flash",
            "effort": "low"
          },
          "high": {
            "model": [
              "gemini-4-argon",
              "gemini-3.8-flash"
            ],
            "effort": "medium"
          }
        }
      ]
    },
    "opencode": {
      "sandbox": false,
      "targets": [
        {
          "low": {
            "model": "opencode-go/muse-spark-1.3-contributor",
            "effort": "xhigh"
          }
        },
        {
          "low": {
            "model": "opencode-go/deepseek-v4.1-flash",
            "effort": "high"
          },
          "max": {
            "model": "opencode-go/deepseek-v4.1-flash",
            "effort": "max"
          }
        }
      ]
    }
  },
  "write-subagents": {
    "claude": {
      "low": {
        "model": "claude-haiku-5-5",
        "effort": "high"
      },
      "high": {
        "model": "claude-sonnet-5-5",
        "effort": "medium"
      },
      "max": {
        "model": "claude-opus-5-5",
        "effort": "medium"
      }
    },
    "codex": {
      "low": {
        "model": "gpt-6-luna",
        "effort": "max"
      },
      "high": {
        "model": "gpt-6.1-sol",
        "effort": "low"
      },
      "max": {
        "model": "gpt-6.1-sol",
        "effort": "medium"
      }
    },
    "agy": {
      "low": {
        "model": "gemini-3.8-flash",
        "effort": "medium"
      }
    },
    "opencode": {
      "low": {
        "model": "opencode-go/muse-spark-1.3-contributor",
        "effort": "xhigh"
      }
    }
  },
  "phases": {
    "plan-review": {
      "targets": {
        "low": 0,
        "medium": 2,
        "high": 3,
        "xhigh": 3,
        "max": "all"
      },
      "rounds": {
        "low": 0,
        "medium": 2,
        "high": 3,
        "max": 5
      }
    },
    "code-review": {
      "targets": {
        "low": 1,
        "medium": 2,
        "high": 3,
        "xhigh": 4,
        "max": "all"
      },
      "rounds": {
        "low": 1,
        "medium": 3,
        "max": 5
      }
    }
  }
}
```

</details>
