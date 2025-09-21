# Simple PowerShell script to generate INSERT statements using T-SQL approach
param(
    [string]$ServerName = "PC-TRADER",
    [string]$DatabaseName = "stateeval",
    [string]$OutputFile = "stateeval-data-complete.sql"
)

Write-Host "Generating complete data script for database: $DatabaseName"

# Create the T-SQL script that generates INSERT statements
$generateScript = @"
-- Data generation script for $DatabaseName
USE [$DatabaseName]
GO

DECLARE @TableName NVARCHAR(128)
DECLARE @SQL NVARCHAR(MAX)
DECLARE @InsertSQL NVARCHAR(MAX)

PRINT '-- ==================================================='
PRINT '-- Complete Data Script for Database: $DatabaseName'
PRINT '-- Generated on: ' + CONVERT(VARCHAR, GETDATE())
PRINT '-- ==================================================='
PRINT ''
PRINT 'USE [$DatabaseName]'
PRINT 'GO'
PRINT ''

DECLARE table_cursor CURSOR FOR
SELECT TABLE_NAME
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_TYPE = 'BASE TABLE'
ORDER BY TABLE_NAME

OPEN table_cursor
FETCH NEXT FROM table_cursor INTO @TableName

WHILE @@FETCH_STATUS = 0
BEGIN
    -- Check if table has data
    SET @SQL = 'SELECT @count = COUNT(*) FROM [' + @TableName + ']'

    DECLARE @Count INT
    EXEC sp_executesql @SQL, N'@count INT OUTPUT', @count = @Count OUTPUT

    IF @Count > 0
    BEGIN
        PRINT '-- =============================================='
        PRINT '-- Table: ' + @TableName + ' (' + CAST(@Count AS VARCHAR) + ' rows)'
        PRINT '-- =============================================='

        -- Check for identity columns
        DECLARE @HasIdentity BIT = 0
        SELECT @HasIdentity = 1
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = @TableName
        AND COLUMNPROPERTY(OBJECT_ID(TABLE_SCHEMA+'.'+TABLE_NAME), COLUMN_NAME, 'IsIdentity') = 1

        IF @HasIdentity = 1
        BEGIN
            PRINT 'SET IDENTITY_INSERT [' + @TableName + '] ON'
        END

        -- Generate INSERT statements
        SET @SQL = '
        SELECT ''INSERT INTO [' + @TableName + '] ('' +
               STUFF((SELECT '', ['' + COLUMN_NAME + '']''
                      FROM INFORMATION_SCHEMA.COLUMNS
                      WHERE TABLE_NAME = ''''' + @TableName + '''''
                      ORDER BY ORDINAL_POSITION
                      FOR XML PATH('''')), 1, 2, '''') +
               '') VALUES ('' +
               STUFF((SELECT '', '' +
                      CASE
                        WHEN c.DATA_TYPE IN (''varchar'', ''nvarchar'', ''char'', ''nchar'', ''text'', ''ntext'', ''uniqueidentifier'', ''date'', ''datetime'', ''datetime2'', ''time'')
                        THEN ISNULL('''''''' + REPLACE(CAST(['' + c.COLUMN_NAME + ''] AS NVARCHAR(MAX)), '''''''''', '''''''''''') + '''''''', ''NULL'')
                        WHEN c.DATA_TYPE IN (''bit'')
                        THEN ISNULL(CAST(['' + c.COLUMN_NAME + ''] AS VARCHAR), ''NULL'')
                        ELSE ISNULL(CAST(['' + c.COLUMN_NAME + ''] AS VARCHAR), ''NULL'')
                      END
                      FROM INFORMATION_SCHEMA.COLUMNS c
                      WHERE c.TABLE_NAME = ''''' + @TableName + '''''
                      ORDER BY c.ORDINAL_POSITION
                      FOR XML PATH('''')), 1, 2, '''') +
               '');'' + CHAR(13) + CHAR(10)
        FROM [' + @TableName + ']'

        EXEC (@SQL)

        IF @HasIdentity = 1
        BEGIN
            PRINT 'SET IDENTITY_INSERT [' + @TableName + '] OFF'
        END

        PRINT 'GO'
        PRINT ''
    END
    ELSE
    BEGIN
        PRINT '-- Table [' + @TableName + '] is empty'
        PRINT ''
    END

    FETCH NEXT FROM table_cursor INTO @TableName
END

CLOSE table_cursor
DEALLOCATE table_cursor

PRINT '-- Script generation completed: ' + CONVERT(VARCHAR, GETDATE())
"@

# Execute the script and save output
Write-Host "Executing T-SQL generation script..."
sqlcmd -S $ServerName -d $DatabaseName -E -Q $generateScript -o $OutputFile -h-1

Write-Host "Data script generated: $OutputFile"

# Check file size
$fileInfo = Get-Item $OutputFile -ErrorAction SilentlyContinue
if ($fileInfo) {
    Write-Host "File size: $([math]::Round($fileInfo.Length / 1MB, 2)) MB"
} else {
    Write-Host "Warning: Output file not found"
}