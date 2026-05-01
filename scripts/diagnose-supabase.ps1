#requires -Version 5.1
<#
.SYNOPSIS
    Diagnose Supabase / Postgres pooler connectivity from this machine.

.DESCRIPTION
    Reads `DATABASE_URL` from `apps/web/.env.local` (or from the env if
    already set), extracts the host/port, and runs three checks:

      1) DNS A   (IPv4) lookup
      2) DNS AAAA (IPv6) lookup
      3) TCP connect to the host on the parsed port

    The script prints a short report you can paste back. It does NOT log
    the password or the full connection string.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\diagnose-supabase.ps1

    # Or, if you want to test a different connection string explicitly:
    $env:DATABASE_URL = "postgres://user:pass@host:6543/postgres"
    powershell -ExecutionPolicy Bypass -File scripts\diagnose-supabase.ps1
#>

[CmdletBinding()]
param(
    [string] $EnvFile = "apps/web/.env.local"
)

$ErrorActionPreference = "Stop"

function Get-DatabaseUrl {
    param([string] $EnvPath)

    if ($env:DATABASE_URL) {
        return $env:DATABASE_URL
    }
    if (-not (Test-Path -LiteralPath $EnvPath)) {
        throw "DATABASE_URL not in env and $EnvPath not found. Set DATABASE_URL or pass -EnvFile."
    }
    foreach ($line in Get-Content -LiteralPath $EnvPath) {
        $trim = $line.Trim()
        if ($trim -like "DATABASE_URL=*") {
            $value = $trim.Substring("DATABASE_URL=".Length).Trim('"').Trim("'")
            if ($value) { return $value }
        }
    }
    throw "DATABASE_URL not found in env nor in $EnvPath."
}

function ConvertTo-HostPort {
    param([string] $ConnString)

    # postgres://user:pass@host:port/db?...
    $u = [System.Uri]::new($ConnString)
    [pscustomobject]@{
        Host = $u.Host
        Port = if ($u.Port -gt 0) { $u.Port } else { 5432 }
    }
}

function Test-DnsLookup {
    param([string] $Hostname, [string] $Type)

    try {
        $rec = Resolve-DnsName -Name $Hostname -Type $Type -ErrorAction Stop -DnsOnly
        $values = @()
        foreach ($r in $rec) {
            if ($Type -eq "A"    -and $r.IPAddress) { $values += $r.IPAddress }
            if ($Type -eq "AAAA" -and $r.IPAddress) { $values += $r.IPAddress }
        }
        return @{ ok = $true; values = $values }
    } catch {
        return @{ ok = $false; error = $_.Exception.Message }
    }
}

function Test-TcpConnect {
    param([string] $Target, [int] $Port, [int] $TimeoutMs = 5000)

    $client = $null
    try {
        $client = [System.Net.Sockets.TcpClient]::new()
        $task = $client.ConnectAsync($Target, $Port)
        if ($task.Wait($TimeoutMs)) {
            $ok = $client.Connected
            return @{ ok = $ok }
        } else {
            return @{ ok = $false; error = "timeout after ${TimeoutMs}ms" }
        }
    } catch {
        return @{ ok = $false; error = $_.Exception.Message }
    } finally {
        if ($client) { $client.Close() }
    }
}

# ── main ────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "Supabase / Postgres pooler diagnostic" -ForegroundColor Cyan
Write-Host "──────────────────────────────────────"

$cs = Get-DatabaseUrl -EnvPath $EnvFile
$hp = ConvertTo-HostPort -ConnString $cs
Write-Host ("Host        : " + $hp.Host)
Write-Host ("Port        : " + $hp.Port)
Write-Host ""

$ipv4 = Test-DnsLookup -Hostname $hp.Host -Type "A"
$ipv6 = Test-DnsLookup -Hostname $hp.Host -Type "AAAA"

if ($ipv4.ok) {
    Write-Host ("DNS A       : " + ($ipv4.values -join ", ")) -ForegroundColor Green
} else {
    Write-Host ("DNS A       : FAILED — " + $ipv4.error) -ForegroundColor Yellow
}
if ($ipv6.ok) {
    Write-Host ("DNS AAAA    : " + ($ipv6.values -join ", ")) -ForegroundColor Green
} else {
    Write-Host ("DNS AAAA    : FAILED — " + $ipv6.error) -ForegroundColor Yellow
}
Write-Host ""

# Hostname-level connect — this is what Node.js does by default.
Write-Host ("TCP " + $hp.Host + ":" + $hp.Port + " (default DNS order)") -ForegroundColor Cyan
$resHost = Test-TcpConnect -Target $hp.Host -Port $hp.Port
if ($resHost.ok) {
    Write-Host "  -> OK" -ForegroundColor Green
} else {
    Write-Host ("  -> FAILED: " + $resHost.error) -ForegroundColor Red
}

# Per-family connect — confirms whether IPv4 works while IPv6 hangs.
if ($ipv4.ok) {
    foreach ($ip in $ipv4.values) {
        Write-Host ("TCP " + $ip + ":" + $hp.Port + " (IPv4)") -ForegroundColor Cyan
        $r = Test-TcpConnect -Target $ip -Port $hp.Port
        if ($r.ok) {
            Write-Host "  -> OK" -ForegroundColor Green
        } else {
            Write-Host ("  -> FAILED: " + $r.error) -ForegroundColor Red
        }
    }
}
if ($ipv6.ok) {
    foreach ($ip in $ipv6.values) {
        Write-Host ("TCP [" + $ip + "]:" + $hp.Port + " (IPv6)") -ForegroundColor Cyan
        $r = Test-TcpConnect -Target $ip -Port $hp.Port
        if ($r.ok) {
            Write-Host "  -> OK" -ForegroundColor Green
        } else {
            Write-Host ("  -> FAILED: " + $r.error) -ForegroundColor Red
        }
    }
}

Write-Host ""
Write-Host "Reading: green ok, yellow no-record, red unreachable." -ForegroundColor DarkGray
Write-Host "If IPv4 OK + IPv6 FAILED -> apply CHECKPOINTER_DNS_ORDER=ipv4first (default)." -ForegroundColor DarkGray
Write-Host "If both FAILED            -> firewall/VPN/ISP, try a different network." -ForegroundColor DarkGray
Write-Host "If both OK                -> the pooler is reachable; the issue is elsewhere." -ForegroundColor DarkGray
Write-Host ""
