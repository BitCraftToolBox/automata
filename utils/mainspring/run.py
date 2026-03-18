#!/usr/bin/env python3
"""
Simple runner script for mainspring.
Usage: python run.py [--config config.yml]
"""

import sys
import os
import asyncio

# Add current directory to path so we can import the mainspring package
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from mainspring import main

if __name__ == "__main__":
    asyncio.run(main())
