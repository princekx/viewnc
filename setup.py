from setuptools import setup, find_packages

setup(
    name="viewnc",
    version="0.1.0",
    description="Interactive iris data viewer for NetCDF, PP and GRIB files",
    author="Prince Xavier",
    packages=find_packages(),
    include_package_data=True,
    package_data={
        "viewnc": [
            "templates/*.html",
            "static/*.css",
            "static/*.js",
        ]
    },
    install_requires=[
        "flask>=3.0",
        "bokeh>=3.0",
        "numpy",
    ],
    entry_points={
        "console_scripts": [
            "viewnc=viewnc.cli:main",
        ]
    },
    python_requires=">=3.9",
)
