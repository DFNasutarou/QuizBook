#!/usr/bin/env pwsh

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

git config core.hooksPath .githooks
Write-Host "Configured core.hooksPath=.githooks"
