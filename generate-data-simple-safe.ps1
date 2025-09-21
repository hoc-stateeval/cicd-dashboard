# Safe and simple data script generator
param(
    [string]$ServerName = "PC-TRADER",
    [string]$DatabaseName = "stateeval",
    [string]$OutputFile = "stateeval-data-safe.sql"
)

Write-Host "Generating safe data script for database: $DatabaseName"

# Create output file with header
@"
-- Data script for database: $DatabaseName
-- Generated on: $(Get-Date)

USE [$DatabaseName]
GO

"@ | Out-File -FilePath $OutputFile -Encoding UTF8

# Get tables with row counts
Write-Host "Getting table information..."
$tableInfo = sqlcmd -S $ServerName -d $DatabaseName -E -Q @"
SELECT
    t.TABLE_NAME,
    CASE WHEN EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS c
        WHERE c.TABLE_NAME = t.TABLE_NAME
        AND COLUMNPROPERTY(OBJECT_ID(c.TABLE_SCHEMA+'.'+c.TABLE_NAME), c.COLUMN_NAME, 'IsIdentity') = 1
    ) THEN 1 ELSE 0 END as HasIdentity
FROM INFORMATION_SCHEMA.TABLES t
WHERE t.TABLE_TYPE = 'BASE TABLE'
ORDER BY t.TABLE_NAME
"@ -h-1 -s"|"

foreach ($line in $tableInfo) {
    if ($line.Trim() -ne "" -and $line -notlike "*rows affected*") {
        $parts = $line.Split('|')
        if ($parts.Length -ge 2) {
            $tableName = $parts[0].Trim()
            $hasIdentity = $parts[1].Trim() -eq "1"

            # Check row count
            $rowCount = sqlcmd -S $ServerName -d $DatabaseName -E -Q "SELECT COUNT(*) FROM [$tableName]" -h-1
            $rowCount = $rowCount.Trim()

            if ([int]$rowCount -gt 0) {
                Write-Host "Processing $tableName ($rowCount rows)..."

                # Add table header
                "`r`n-- ==============================================" | Out-File -FilePath $OutputFile -Append -Encoding UTF8
                "-- Table: $tableName ($rowCount rows)" | Out-File -FilePath $OutputFile -Append -Encoding UTF8
                "-- ==============================================" | Out-File -FilePath $OutputFile -Append -Encoding UTF8

                if ($hasIdentity) {
                    "SET IDENTITY_INSERT [$tableName] ON" | Out-File -FilePath $OutputFile -Append -Encoding UTF8
                }

                # Use BCP to export data as INSERT statements
                $tempFile = "temp_$tableName.txt"

                # Export data using BCP
                bcp "SELECT * FROM [$DatabaseName].dbo.[$tableName]" queryout $tempFile -S $ServerName -T -c -t"|" | Out-Null

                if (Test-Path $tempFile) {
                    # Get column information
                    $columns = sqlcmd -S $ServerName -d $DatabaseName -E -Q @"
SELECT COLUMN_NAME + '|' + DATA_TYPE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = '$tableName'
ORDER BY ORDINAL_POSITION
"@ -h-1

                    $columnNames = @()
                    $columnTypes = @()

                    foreach ($colLine in $columns) {
                        if ($colLine.Trim() -ne "" -and $colLine -notlike "*rows affected*") {
                            $colParts = $colLine.Split('|')
                            if ($colParts.Length -ge 2) {
                                $columnNames += $colParts[0].Trim()
                                $columnTypes += $colParts[1].Trim()
                            }
                        }
                    }

                    if ($columnNames.Count -gt 0) {
                        $columnsString = ($columnNames | ForEach-Object { "[$_]" }) -join ", "

                        # Read the data file and convert to INSERT statements
                        $data = Get-Content $tempFile -Encoding UTF8
                        foreach ($row in $data) {
                            if ($row.Trim() -ne "") {
                                $values = $row -split '\|'
                                $valuesList = @()

                                for ($i = 0; $i -lt $values.Length -and $i -lt $columnTypes.Length; $i++) {
                                    $value = $values[$i].Trim()
                                    $dataType = $columnTypes[$i]

                                    if ($value -eq "" -or $value -eq "NULL") {
                                        $valuesList += "NULL"
                                    } elseif ($dataType -in @('varchar', 'nvarchar', 'char', 'nchar', 'text', 'ntext', 'uniqueidentifier', 'date', 'datetime', 'datetime2', 'time', 'datetimeoffset')) {
                                        $escapedValue = $value -replace "'", "''"
                                        $valuesList += "'$escapedValue'"
                                    } else {
                                        $valuesList += $value
                                    }
                                }

                                $valuesString = $valuesList -join ", "
                                "INSERT INTO [$tableName] ($columnsString) VALUES ($valuesString);" | Out-File -FilePath $OutputFile -Append -Encoding UTF8
                            }
                        }
                    }

                    # Clean up temp file
                    Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
                } else {
                    Write-Host "Warning: Could not export data for table $tableName"
                }

                if ($hasIdentity) {
                    "SET IDENTITY_INSERT [$tableName] OFF" | Out-File -FilePath $OutputFile -Append -Encoding UTF8
                }

                "GO`r`n" | Out-File -FilePath $OutputFile -Append -Encoding UTF8

            } else {
                Write-Host "Skipping $tableName (empty table)"
            }
        }
    }
}

# Add footer
"`r`n-- Script generation completed: $(Get-Date)" | Out-File -FilePath $OutputFile -Append -Encoding UTF8

Write-Host "Safe data script generated: $OutputFile"
$fileInfo = Get-Item $OutputFile -ErrorAction SilentlyContinue
if ($fileInfo) {
    Write-Host "File size: $([math]::Round($fileInfo.Length / 1MB, 2)) MB"
}