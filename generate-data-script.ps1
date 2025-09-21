# PowerShell script to generate INSERT statements for all tables in stateeval database
param(
    [string]$ServerName = "PC-TRADER",
    [string]$DatabaseName = "stateeval",
    [string]$OutputFile = "stateeval-data-script.sql"
)

# Import SQL Server module if available
try {
    Import-Module SqlServer -ErrorAction SilentlyContinue
} catch {
    Write-Host "SqlServer module not available, using sqlcmd directly"
}

Write-Host "Generating data script for database: $DatabaseName"
Write-Host "Output file: $OutputFile"

# Create output file and add header
@"
-- Data script generated for database: $DatabaseName
-- Generated on: $(Get-Date)
-- Total tables: 125

USE [$DatabaseName]
GO

SET IDENTITY_INSERT ON
GO

"@ | Out-File -FilePath $OutputFile -Encoding UTF8

# Get list of tables
$tables = sqlcmd -S $ServerName -d $DatabaseName -E -Q "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME" -h-1

$tableCount = 0
foreach ($table in $tables) {
    $table = $table.Trim()
    if ($table -ne "") {
        $tableCount++
        Write-Host "Processing table $tableCount/125: $table"

        # Add table header to script
        "`r`n-- ==============================================" | Out-File -FilePath $OutputFile -Append -Encoding UTF8
        "-- Table: $table" | Out-File -FilePath $OutputFile -Append -Encoding UTF8
        "-- ==============================================" | Out-File -FilePath $OutputFile -Append -Encoding UTF8

        # Check if table has data
        $rowCount = sqlcmd -S $ServerName -d $DatabaseName -E -Q "SELECT COUNT(*) FROM [$table]" -h-1 -W
        $rowCount = $rowCount.Trim()

        if ([int]$rowCount -gt 0) {
            Write-Host "  -> $rowCount rows found"

            # Get column information
            $columnInfo = sqlcmd -S $ServerName -d $DatabaseName -E -Q @"
SELECT
    COLUMN_NAME,
    DATA_TYPE,
    IS_NULLABLE,
    COLUMNPROPERTY(OBJECT_ID(TABLE_SCHEMA+'.'+TABLE_NAME), COLUMN_NAME, 'IsIdentity') AS IsIdentity
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = '$table'
ORDER BY ORDINAL_POSITION
"@ -h-1 -s"|"

            $columns = @()
            $identityColumns = @()

            foreach ($colLine in $columnInfo) {
                if ($colLine.Trim() -ne "") {
                    $parts = $colLine.Split('|')
                    if ($parts.Length -ge 4) {
                        $colName = $parts[0].Trim()
                        $isIdentity = $parts[3].Trim()

                        $columns += $colName
                        if ($isIdentity -eq "1") {
                            $identityColumns += $colName
                        }
                    }
                }
            }

            # Enable identity insert if needed
            if ($identityColumns.Count -gt 0) {
                "SET IDENTITY_INSERT [$table] ON" | Out-File -FilePath $OutputFile -Append -Encoding UTF8
            }

            # Generate INSERT statements using BCP-style approach
            $columnsString = ($columns | ForEach-Object { "[$_]" }) -join ", "

            # Use a T-SQL script to generate INSERT statements
            $insertScript = @"
DECLARE @sql NVARCHAR(MAX) = ''
SELECT @sql = @sql + 'INSERT INTO [$table] ($columnsString) VALUES (' +
$(
    $valuesList = @()
    for ($i = 0; $i -lt $columns.Count; $i++) {
        $col = $columns[$i]
        $valuesList += "ISNULL('''' + REPLACE(CAST([$col] AS NVARCHAR(MAX)), '''', '''''') + '''', 'NULL')"
    }
    $valuesList -join " + ', ' + "
) + ');' + CHAR(13) + CHAR(10)
FROM [$table]
PRINT @sql
"@

            "-- INSERT statements for $table" | Out-File -FilePath $OutputFile -Append -Encoding UTF8
            sqlcmd -S $ServerName -d $DatabaseName -E -Q $insertScript -h-1 | Out-File -FilePath $OutputFile -Append -Encoding UTF8

            # Disable identity insert if needed
            if ($identityColumns.Count -gt 0) {
                "SET IDENTITY_INSERT [$table] OFF" | Out-File -FilePath $OutputFile -Append -Encoding UTF8
            }

            "GO`r`n" | Out-File -FilePath $OutputFile -Append -Encoding UTF8
        } else {
            Write-Host "  -> Table is empty, skipping"
            "-- Table [$table] is empty`r`n" | Out-File -FilePath $OutputFile -Append -Encoding UTF8
        }
    }
}

# Add footer
"`r`n-- Script generation completed: $(Get-Date)" | Out-File -FilePath $OutputFile -Append -Encoding UTF8
"-- Total tables processed: $tableCount" | Out-File -FilePath $OutputFile -Append -Encoding UTF8

Write-Host "`nData script generation completed!"
Write-Host "Output file: $OutputFile"
Write-Host "Total tables processed: $tableCount"