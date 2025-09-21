# Fixed PowerShell script to generate proper INSERT statements
param(
    [string]$ServerName = "PC-TRADER",
    [string]$DatabaseName = "stateeval",
    [string]$OutputFile = "stateeval-data-fixed.sql"
)

Write-Host "Generating fixed data script for database: $DatabaseName"

# Create output file with header
@"
-- Data script for database: $DatabaseName
-- Generated on: $(Get-Date)

USE [$DatabaseName]
GO

"@ | Out-File -FilePath $OutputFile -Encoding UTF8

# Get list of tables with data
$tablesWithData = sqlcmd -S $ServerName -d $DatabaseName -E -Q @"
SELECT t.TABLE_NAME,
       (SELECT COUNT(*) FROM [' + t.TABLE_NAME + ']) as RowCount
FROM INFORMATION_SCHEMA.TABLES t
WHERE t.TABLE_TYPE = 'BASE TABLE'
ORDER BY t.TABLE_NAME
"@ -h-1 -s"|"

Write-Host "Processing tables with data..."

foreach ($line in $tablesWithData) {
    if ($line.Trim() -ne "" -and $line -notlike "*rows affected*") {
        $parts = $line.Split('|')
        if ($parts.Length -ge 2) {
            $tableName = $parts[0].Trim()
            $rowCount = $parts[1].Trim()

            if ([int]$rowCount -gt 0) {
                Write-Host "Processing $tableName ($rowCount rows)..."

                # Add table header
                "`r`n-- ==============================================" | Out-File -FilePath $OutputFile -Append -Encoding UTF8
                "-- Table: $tableName ($rowCount rows)" | Out-File -FilePath $OutputFile -Append -Encoding UTF8
                "-- ==============================================" | Out-File -FilePath $OutputFile -Append -Encoding UTF8

                # Check for identity columns
                $identityCheck = sqlcmd -S $ServerName -d $DatabaseName -E -Q @"
SELECT COLUMN_NAME
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = '$tableName'
AND COLUMNPROPERTY(OBJECT_ID(TABLE_SCHEMA+'.'+TABLE_NAME), COLUMN_NAME, 'IsIdentity') = 1
"@ -h-1

                $hasIdentity = $identityCheck.Trim() -ne ""

                if ($hasIdentity) {
                    "SET IDENTITY_INSERT [$tableName] ON" | Out-File -FilePath $OutputFile -Append -Encoding UTF8
                }

                # Generate INSERT using a simpler T-SQL approach
                $insertScript = @"
DECLARE @cols NVARCHAR(MAX) = ''
DECLARE @sql NVARCHAR(MAX) = ''

SELECT @cols = STUFF((
    SELECT ', [' + COLUMN_NAME + ']'
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = '$tableName'
    ORDER BY ORDINAL_POSITION
    FOR XML PATH('')
), 1, 2, '')

DECLARE @values NVARCHAR(MAX) = ''
SELECT @values = STUFF((
    SELECT ', ' +
        CASE
            WHEN DATA_TYPE IN ('varchar', 'nvarchar', 'char', 'nchar', 'text', 'ntext', 'uniqueidentifier', 'date', 'datetime', 'datetime2', 'time', 'datetimeoffset')
            THEN 'ISNULL('''''''' + REPLACE(CAST([' + COLUMN_NAME + '] AS NVARCHAR(MAX)), '''''''', '''''''''''') + '''''''', ''NULL'')'
            WHEN DATA_TYPE IN ('bit')
            THEN 'ISNULL(CAST([' + COLUMN_NAME + '] AS VARCHAR), ''NULL'')'
            ELSE 'ISNULL(CAST([' + COLUMN_NAME + '] AS VARCHAR), ''NULL'')'
        END
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = '$tableName'
    ORDER BY ORDINAL_POSITION
    FOR XML PATH('')
), 1, 2, '')

SET @sql = 'SELECT ''INSERT INTO [$tableName] ('' + @cols + '') VALUES ('' + ' + @values + ' + '');'''
SET @sql = @sql + ' FROM [$tableName]'

EXEC(@sql)
"@

                # Execute and append to file
                sqlcmd -S $ServerName -d $DatabaseName -E -Q $insertScript -h-1 | Out-File -FilePath $OutputFile -Append -Encoding UTF8

                if ($hasIdentity) {
                    "SET IDENTITY_INSERT [$tableName] OFF" | Out-File -FilePath $OutputFile -Append -Encoding UTF8
                }

                "GO`r`n" | Out-File -FilePath $OutputFile -Append -Encoding UTF8
            }
        }
    }
}

# Add footer
"`r`n-- Script generation completed: $(Get-Date)" | Out-File -FilePath $OutputFile -Append -Encoding UTF8

Write-Host "Fixed data script generated: $OutputFile"
$fileInfo = Get-Item $OutputFile -ErrorAction SilentlyContinue
if ($fileInfo) {
    Write-Host "File size: $([math]::Round($fileInfo.Length / 1MB, 2)) MB"
}